//! Stemmeisolering: DeepFilterNet 3 (Hendrik Schröter et al., MIT/Apache-2.0), a neural network
//! that keeps speech and removes everything else – keyboard, mouse, fans, game sound, dogs –
//! also under the words. This is GoXLR Studio's own port of the inference in DeepFilterNet's
//! libDF (v0.5.6: `DFState` analysis/synthesis/features and `DfTract::process`), running the
//! model's three ONNX parts (encoder, ERB decoder, deep-filter decoder) with tract.
//!
//! 48 kHz, 10 ms hops (480 samples), STFT 960 with a Vorbis window, 32 ERB bands for the gains
//! and complex "deep filtering" of order 5 on the lowest 96 bins. The model looks 2 hops ahead,
//! so the output is `LATENCY` samples (30 ms) late.
//!
//! The model files are put in at build time from `DF_MODEL_DIR` (see build.rs).
use realfft::num_complex::Complex32;
use realfft::{ComplexToReal, RealFftPlanner, RealToComplex};
use std::collections::VecDeque;
use std::sync::Arc;
use tract_onnx::prelude::*;
use tract_onnx::tract_hir::shapefactoid;
use tract_pulse::internal::ToDim;
use tract_onnx::tract_hir::infer::ShapeFactoid;
use tract_pulse::model::{PulsedModel, PulsedModelExt};

// The model's config.ini ([df] and [deepfilternet]); build.rs checks the shipped file agrees.
pub const SR: usize = 48000;
pub const FFT: usize = 960;
pub const HOP: usize = 480;
const FREQS: usize = FFT / 2 + 1;
const NB_ERB: usize = 32;
const NB_DF: usize = 96;
const DF_ORDER: usize = 5;
const LOOKAHEAD: usize = 2; // max(conv_lookahead, df_lookahead)
const CONV_CH: usize = 64;
const MIN_NB_ERB_FREQS: usize = 2;
/// exp(-hop/sr/norm_tau) rounded as libDF's calc_norm_alpha does (tau = 1 s).
const ALPHA: f32 = 0.99;
// Above 30 dB local SNR it is clear speech (left as it is); everything else gets both stages.
// libDF also skips the deep filter above 20 dB and silences frames under −10 dB to save time.
// Measured on real speech, both hurt: its ERB gains act on the lowest bins too, which the network
// only trains through the deep filter (10–12 dB off clear speech), and a loud key click on a
// word made the whole 10 ms silent. The network costs about 10 % of one core either way.
const MAX_DB_ERB_THRESH: f32 = 30.0;

/// Voice gate (on top of the network, for silence between the words like Discord): the network's
/// own speech estimate (local SNR) over the frames it can see – the one being output, the ones
/// before it and the two it looks ahead – opens the gate; with no speech for `GATE_HOLD` frames it
/// closes down to `GATE_FLOOR` over about 50 ms. Opening is immediate, and because of the
/// look-ahead it is already open when a word starts.
const GATE_LSNR: f32 = -7.5;
const GATE_HOLD: u32 = 25; // 250 ms
const GATE_FLOOR: f32 = 0.18; // −15 dB
const GATE_RELEASE: f32 = 0.8;

/// Delay through the filter in samples: the STFT's overlap plus the model's look-ahead.
pub const LATENCY: usize = FFT - HOP + LOOKAHEAD * HOP;

static ENC: &[u8] = include_bytes!(concat!(env!("DF_MODEL_DIR"), "/enc.onnx"));
static ERB_DEC: &[u8] = include_bytes!(concat!(env!("DF_MODEL_DIR"), "/erb_dec.onnx"));
static DF_DEC: &[u8] = include_bytes!(concat!(env!("DF_MODEL_DIR"), "/df_dec.onnx"));

type Plan = Arc<TypedSimplePlan<TypedModel>>;
type State = TypedSimpleState<TypedModel, Plan>;

fn freq2erb(f: f32) -> f32 {
    9.265 * (f / (24.7 * 9.265)).ln_1p()
}
fn erb2freq(e: f32) -> f32 {
    24.7 * 9.265 * ((e / 9.265).exp() - 1.0)
}

/// How many FFT bins each ERB band covers (libDF's erb_fb).
pub fn erb_bands() -> Vec<usize> {
    let freq_width = SR as f32 / FFT as f32;
    let (lo, hi) = (freq2erb(0.0), freq2erb((SR / 2) as f32));
    let step = (hi - lo) / NB_ERB as f32;
    let mut erb = vec![0usize; NB_ERB];
    let (mut prev, mut over) = (0i32, 0i32);
    for i in 1..=NB_ERB {
        let fb = (erb2freq(lo + i as f32 * step) / freq_width).round() as i32;
        let mut n = fb - prev - over;
        if n < MIN_NB_ERB_FREQS as i32 {
            over = MIN_NB_ERB_FREQS as i32 - n;
            n = MIN_NB_ERB_FREQS as i32;
        } else {
            over = 0;
        }
        erb[i - 1] = n as usize;
        prev = fb;
    }
    erb[NB_ERB - 1] += 1;
    let total: usize = erb.iter().sum();
    if total > FREQS {
        erb[NB_ERB - 1] -= total - FREQS;
    }
    erb
}

/// Reads one ONNX part and makes it a streaming (one hop at a time) plan, as libDF does.
/// `facts(S)` gives the inputs (name, shape) with S as the time axis.
fn load(bytes: &[u8], facts: impl Fn(Symbol) -> Vec<(&'static str, InferenceFact)>, outputs: &[&str]) -> TractResult<Plan> {
    let mut m = tract_onnx::onnx().with_ignore_output_shapes(true).model_for_read(&mut std::io::Cursor::new(bytes))?;
    let s = m.symbol_table.sym("S");
    let inputs = facts(s.clone());
    for (i, (_, fact)) in inputs.iter().enumerate() {
        m = m.with_input_fact(i, fact.clone())?;
    }
    m = m.with_input_names(inputs.iter().map(|(n, _)| *n))?.with_output_names(outputs)?;
    m.analyse(true)?;
    let mut m = m.into_typed()?;
    m.declutter()?;
    let pulsed = PulsedModel::new(&m, s, &1.to_dim())?;
    Ok(Arc::new(pulsed.into_typed()?.into_optimized()?.into_runnable()?))
}

/// The three networks, built and optimized (the slow part; can be sent to another thread).
pub struct Plans {
    enc: Plan,
    erb_dec: Plan,
    df_dec: Plan,
}

fn f32_fact(shape: ShapeFactoid) -> InferenceFact {
    InferenceFact::dt_shape(f32::datum_type(), shape)
}

/// Builds the networks (a second or two: call it off the audio thread).
pub fn load_plans() -> Result<Plans, String> {
    plans().map_err(|e| format!("{e:#}"))
}

fn plans() -> TractResult<Plans> {
    let hidden = CONV_CH * NB_ERB / 4;
    let (q, h) = (NB_ERB / 4, NB_ERB / 2);
    let enc = load(
        ENC,
        |s| vec![("feat_erb", f32_fact(shapefactoid!(1, 1, s, NB_ERB))), ("feat_spec", f32_fact(shapefactoid!(1, 2, s, NB_DF)))],
        &["e0", "e1", "e2", "e3", "emb", "c0", "lsnr"],
    )?;
    let erb_dec = load(
        ERB_DEC,
        |s| {
            vec![
                ("emb", f32_fact(shapefactoid!(1, s, hidden))),
                ("e3", f32_fact(shapefactoid!(1, CONV_CH, s, q))),
                ("e2", f32_fact(shapefactoid!(1, CONV_CH, s, q))),
                ("e1", f32_fact(shapefactoid!(1, CONV_CH, s, h))),
                ("e0", f32_fact(shapefactoid!(1, CONV_CH, s, NB_ERB))),
            ]
        },
        &["m"],
    )?;
    let df_dec = load(DF_DEC, |s| vec![("emb", f32_fact(shapefactoid!(1, s, hidden))), ("c0", f32_fact(shapefactoid!(1, CONV_CH, s, NB_DF)))], &["coefs"])?;
    Ok(Plans { enc, erb_dec, df_dec })
}

pub struct DeepFilter {
    plans: Plans,
    enc: State,
    erb_dec: State,
    df_dec: State,
    fwd: Arc<dyn RealToComplex<f32>>,
    inv: Arc<dyn ComplexToReal<f32>>,
    window: Vec<f32>,
    wnorm: f32,
    erb: Vec<usize>,
    analysis_mem: Vec<f32>,
    synthesis_mem: Vec<f32>,
    time: Vec<f32>,
    fscratch: Vec<Complex32>,
    iscratch: Vec<Complex32>,
    mean_norm: Vec<f32>,
    unit_norm: Vec<f32>,
    spec: Vec<Complex32>,
    enh: Vec<Complex32>,
    // The last spectra: noisy (for the deep filter) and stage-1 enhanced (gains applied).
    roll_x: VecDeque<Vec<Complex32>>,
    roll_y: VecDeque<Vec<Complex32>>,
    feat_erb: Vec<f32>,
    feat_spec: Vec<f32>,
    /// The model's last local SNR estimate (dB).
    pub lsnr: f32,
    /// Voice gate between the words (see GATE_*).
    pub gate: bool,
    gate_gain: f32,
    gate_hold: u32,
    quiet: u32,
}

impl DeepFilter {
    /// Builds the networks and the filter (takes a while: off the audio thread, or use
    /// `load_plans` there and `from_plans` here).
    pub fn new() -> Result<DeepFilter, String> {
        DeepFilter::from_plans(load_plans()?)
    }

    /// The filter around networks built by `load_plans` (quick).
    pub fn from_plans(plans: Plans) -> Result<DeepFilter, String> {
        let st = |p: &Plan| SimpleState::new(p.clone()).map_err(|e| format!("{e:#}"));
        let (enc, erb_dec, df_dec) = (st(&plans.enc)?, st(&plans.erb_dec)?, st(&plans.df_dec)?);
        let mut planner = RealFftPlanner::<f32>::new();
        let fwd = planner.plan_fft_forward(FFT);
        let inv = planner.plan_fft_inverse(FFT);
        let half = FFT / 2;
        let window = (0..FFT)
            .map(|i| {
                let s = (0.5 * std::f64::consts::PI * (i as f64 + 0.5) / half as f64).sin();
                (0.5 * std::f64::consts::PI * s * s).sin() as f32
            })
            .collect();
        let mut df = DeepFilter {
            enc,
            erb_dec,
            df_dec,
            fscratch: fwd.make_scratch_vec(),
            iscratch: inv.make_scratch_vec(),
            fwd,
            inv,
            plans,
            window,
            wnorm: 1.0 / ((FFT * FFT) as f32 / (2 * HOP) as f32),
            erb: erb_bands(),
            analysis_mem: vec![0.0; FFT - HOP],
            synthesis_mem: vec![0.0; FFT - HOP],
            time: vec![0.0; FFT],
            mean_norm: Vec::new(),
            unit_norm: Vec::new(),
            spec: vec![Complex32::default(); FREQS],
            enh: vec![Complex32::default(); FREQS],
            roll_x: VecDeque::new(),
            roll_y: VecDeque::new(),
            feat_erb: vec![0.0; NB_ERB],
            feat_spec: vec![0.0; 2 * NB_DF],
            lsnr: 0.0,
            gate: true,
            gate_gain: 1.0,
            gate_hold: 0,
            quiet: 0,
        };
        df.reset()?;
        Ok(df)
    }

    /// Starts over (new network states, empty buffers).
    pub fn reset(&mut self) -> Result<(), String> {
        let st = |p: &Plan| SimpleState::new(p.clone()).map_err(|e| format!("{e:#}"));
        self.enc = st(&self.plans.enc)?;
        self.erb_dec = st(&self.plans.erb_dec)?;
        self.df_dec = st(&self.plans.df_dec)?;
        self.analysis_mem.fill(0.0);
        self.gate_gain = 1.0;
        self.gate_hold = 0;
        self.quiet = 0;
        self.synthesis_mem.fill(0.0);
        // libDF's init_norm_states: linear from −60 to −90 dB, and from 0.001 to 0.0001.
        self.mean_norm = (0..NB_ERB).map(|i| -60.0 + i as f32 * (-30.0 / (NB_ERB - 1) as f32)).collect();
        self.unit_norm = (0..NB_DF).map(|i| 0.001 + i as f32 * (-0.0009 / (NB_DF - 1) as f32)).collect();
        self.roll_x = (0..DF_ORDER.max(LOOKAHEAD)).map(|_| vec![Complex32::default(); FREQS]).collect();
        self.roll_y = (0..DF_ORDER + LOOKAHEAD).map(|_| vec![Complex32::default(); FREQS]).collect();
        Ok(())
    }

    fn analysis(&mut self, input: &[f32]) {
        let split = FFT - HOP;
        for i in 0..split {
            self.time[i] = self.analysis_mem[i] * self.window[i];
        }
        for i in 0..HOP {
            self.time[split + i] = input[i] * self.window[split + i];
        }
        // hop = fft/2: the memory is just this input.
        self.analysis_mem.copy_from_slice(&input[..split]);
        let _ = self.fwd.process_with_scratch(&mut self.time, &mut self.spec, &mut self.fscratch);
        for x in self.spec.iter_mut() {
            *x *= self.wnorm;
        }
    }

    fn synthesis(&mut self, out: &mut [f32]) {
        // A real signal: no imaginary part at DC and Nyquist.
        self.enh[0].im = 0.0;
        self.enh[FREQS - 1].im = 0.0;
        let _ = self.inv.process_with_scratch(&mut self.enh, &mut self.time, &mut self.iscratch);
        for (x, w) in self.time.iter_mut().zip(self.window.iter()) {
            *x *= w;
        }
        for i in 0..HOP {
            out[i] = self.time[i] + self.synthesis_mem[i];
        }
        self.synthesis_mem.copy_from_slice(&self.time[HOP..]);
    }

    fn features(&mut self) {
        let mut bin = 0;
        for (b, &n) in self.erb.iter().enumerate() {
            let mut e = 0.0;
            for x in &self.spec[bin..bin + n] {
                e += x.re * x.re + x.im * x.im;
            }
            bin += n;
            let db = (e / n as f32 + 1e-10).log10() * 10.0;
            let s = &mut self.mean_norm[b];
            *s = db * (1.0 - ALPHA) + *s * ALPHA;
            self.feat_erb[b] = (db - *s) / 40.0;
        }
        for f in 0..NB_DF {
            let x = self.spec[f];
            let s = &mut self.unit_norm[f];
            *s = x.norm() * (1.0 - ALPHA) + *s * ALPHA;
            let d = s.sqrt();
            self.feat_spec[f] = x.re / d;
            self.feat_spec[NB_DF + f] = x.im / d;
        }
    }

    fn voice_gate(&mut self, lsnr: f32) {
        if !self.gate {
            return;
        }
        // `lsnr` is for the newest frame, which is LOOKAHEAD frames ahead of the one going out:
        // speech there (or in the hold time after it) keeps the gate open.
        if lsnr > GATE_LSNR {
            self.gate_hold = GATE_HOLD + LOOKAHEAD as u32;
        }
        if self.gate_hold > 0 {
            self.gate_hold -= 1;
            self.gate_gain = 1.0;
        } else {
            self.gate_gain = (self.gate_gain * GATE_RELEASE).max(GATE_FLOOR);
        }
        if self.gate_gain < 1.0 {
            let g = self.gate_gain;
            self.enh.iter_mut().for_each(|v| *v *= g);
        }
    }

    /// One 10 ms hop (480 samples at 48 kHz) in, one out (`LATENCY` samples later).
    pub fn process(&mut self, input: &[f32], out: &mut [f32]) -> Result<(), String> {
        self.process_inner(input, out).map_err(|e| format!("{e:#}"))
    }

    fn process_inner(&mut self, input: &[f32], out: &mut [f32]) -> TractResult<()> {
        // Digital silence (e.g. the GoXLR's gate closed): nothing to do – once what is still in
        // the filter (the end of the last word) has come out.
        let rms = input.iter().map(|x| x * x).sum::<f32>() / input.len() as f32;
        self.quiet = if rms < 1e-7 { self.quiet.saturating_add(1) } else { 0 };
        if self.quiet as usize > LOOKAHEAD + 2 {
            out.fill(0.0);
            self.lsnr = -15.0;
            self.gate_hold = self.gate_hold.saturating_sub(1);
            return Ok(());
        }
        self.analysis(input);
        let mut x = self.roll_x.pop_front().unwrap_or_default();
        x.clear();
        x.extend_from_slice(&self.spec);
        self.roll_x.push_back(x);
        let mut y = self.roll_y.pop_front().unwrap_or_default();
        y.clear();
        y.extend_from_slice(&self.spec);
        self.roll_y.push_back(y);

        self.features();
        let erb_in = Tensor::from_shape(&[1, 1, 1, NB_ERB], &self.feat_erb)?;
        let spec_in = Tensor::from_shape(&[1, 2, 1, NB_DF], &self.feat_spec)?;
        let mut enc = self.enc.run(tvec!(erb_in.into(), spec_in.into()))?;
        let lsnr = *enc.pop().unwrap().to_scalar::<f32>()?;
        self.lsnr = lsnr;
        let c0 = enc.pop().unwrap();
        let emb = enc.pop().unwrap();
        // Clear speech (local SNR over 30 dB) is left as it is; everything else gets both stages.
        let apply = lsnr <= MAX_DB_ERB_THRESH;

        // Stage 1: gains per ERB band on the frame `LOOKAHEAD` hops back.
        let target = &mut self.roll_y[DF_ORDER - 1];
        if apply {
            let (e3, e2, e1, e0) = (enc.pop().unwrap(), enc.pop().unwrap(), enc.pop().unwrap(), enc.pop().unwrap());
            let m = self.erb_dec.run(tvec!(emb.clone(), e3, e2, e1, e0))?.pop().unwrap();
            let g = m.as_slice::<f32>()?;
            let mut bin = 0;
            for (&n, &gain) in self.erb.iter().zip(g.iter()) {
                for v in &mut target[bin..bin + n] {
                    *v *= gain;
                }
                bin += n;
            }
        }
        self.enh.copy_from_slice(&self.roll_y[DF_ORDER - 1]);

        // Stage 2: deep filtering of the lowest bins from the last DF_ORDER noisy frames.
        if apply {
            let coefs = self.df_dec.run(tvec!(emb, c0))?.pop().unwrap();
            let c = coefs.as_slice::<f32>()?;
            if c.len() >= NB_DF * DF_ORDER * 2 {
                for v in &mut self.enh[..NB_DF] {
                    *v = Complex32::default();
                }
                for (k, frame) in self.roll_x.iter().enumerate().take(DF_ORDER) {
                    for f in 0..NB_DF {
                        let i = (f * DF_ORDER + k) * 2;
                        self.enh[f] += frame[f] * Complex32::new(c[i], c[i + 1]);
                    }
                }
            }
        }
        self.voice_gate(lsnr);
        self.synthesis(out);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn erb_bands_cover_every_bin() {
        let e = erb_bands();
        assert_eq!(e.len(), NB_ERB);
        assert_eq!(e.iter().sum::<usize>(), FREQS);
        assert!(e.iter().all(|&n| n >= MIN_NB_ERB_FREQS));
        assert_eq!(LATENCY, 1440);
    }
}
