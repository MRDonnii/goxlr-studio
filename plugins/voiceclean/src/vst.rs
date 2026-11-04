//! The VST 2.4 plugin ABI (as in plugins/dynamics: only the plain C structures and numbers a host
//! uses). Equalizer APO loads the DLL on the mic, calls `VSTPluginMain`, sets the parameters by
//! name and calls `processReplacing` with the audio (two channels per instance; a mono mic gets a
//! silent second channel).
//!
//! Safety first: this runs inside Windows' audio engine. Every call is wrapped in `catch_unwind`;
//! after a panic the plugin passes the mic through untouched for the rest of its life.
use crate::{Cleaner, Settings, DEFAULTS, FRAME, PARAMS, RATE};
use std::ffi::c_void;
use std::os::raw::c_char;
use std::panic::{catch_unwind, AssertUnwindSafe};

type HostCallback = extern "C" fn(*mut AEffect, i32, i32, isize, *mut c_void, f32) -> isize;
type Dispatcher = extern "C" fn(*mut AEffect, i32, i32, isize, *mut c_void, f32) -> isize;
type Process = extern "C" fn(*mut AEffect, *const *const f32, *mut *mut f32, i32);
type ProcessDouble = extern "C" fn(*mut AEffect, *const *const f64, *mut *mut f64, i32);
type SetParameter = extern "C" fn(*mut AEffect, i32, f32);
type GetParameter = extern "C" fn(*mut AEffect, i32) -> f32;

#[repr(C)]
pub struct AEffect {
    magic: i32,
    dispatcher: Dispatcher,
    process: Process,
    set_parameter: SetParameter,
    get_parameter: GetParameter,
    num_programs: i32,
    num_params: i32,
    num_inputs: i32,
    num_outputs: i32,
    flags: i32,
    reserved1: isize,
    reserved2: isize,
    initial_delay: i32,
    real_qualities: i32,
    off_qualities: i32,
    io_ratio: f32,
    object: *mut c_void,
    user: *mut c_void,
    unique_id: i32,
    version: i32,
    process_replacing: Process,
    process_double_replacing: ProcessDouble,
    future: [u8; 56],
}

const MAGIC: i32 = i32::from_be_bytes(*b"VstP");
const FLAG_CAN_REPLACING: i32 = 1 << 4;
const ID: i32 = i32::from_be_bytes(*b"GXvc");

const EFF_CLOSE: i32 = 1;
const EFF_GET_PARAM_LABEL: i32 = 6;
const EFF_GET_PARAM_DISPLAY: i32 = 7;
const EFF_GET_PARAM_NAME: i32 = 8;
const EFF_SET_SAMPLE_RATE: i32 = 10;
const EFF_MAINS_CHANGED: i32 = 12;
const EFF_GET_PLUG_CATEGORY: i32 = 35;
const EFF_GET_EFFECT_NAME: i32 = 45;
const EFF_GET_VENDOR_STRING: i32 = 47;
const EFF_GET_PRODUCT_STRING: i32 = 48;
const EFF_GET_VENDOR_VERSION: i32 = 49;
const EFF_CAN_DO: i32 = 51;
const EFF_GET_TAIL_SIZE: i32 = 52;
const EFF_GET_VST_VERSION: i32 = 58;
const CATEGORY_EFFECT: isize = 1;

/// The echo reference as the plugin sees it (shared memory on Windows; tests set it directly).
pub(crate) trait Reference: Send {
    /// Reads what arrived since last time (at most `out.len()`), returns how many.
    fn read(&mut self, out: &mut [f32]) -> usize;
    /// Tells GoXLR Studio how it is going.
    fn report(&mut self, flags: u32, erle_db: f32, delay_ms: i32);
}

struct Plugin {
    params: [f32; 3],
    dsp: Cleaner,
    rate: f32,
    broken: bool,
    reference: Option<Box<dyn Reference>>,
    mono: Vec<f32>,
    refbuf: Vec<f32>,
    blocks: u32,
}

fn plugin<'a>(e: *mut AEffect) -> Option<&'a mut Plugin> {
    unsafe { e.as_mut().and_then(|e| (e.object as *mut Plugin).as_mut()) }
}

fn put(ptr: *mut c_void, s: &str, max: usize) {
    if ptr.is_null() {
        return;
    }
    let b = s.as_bytes();
    let n = b.len().min(max.saturating_sub(1));
    unsafe {
        std::ptr::copy_nonoverlapping(b.as_ptr(), ptr as *mut u8, n);
        *(ptr as *mut u8).add(n) = 0;
    }
}

fn display(index: usize, v: f32) -> &'static str {
    match index {
        1 => if v < 0.25 { "Off" } else if v < 0.75 { "Normal" } else { "Strong" },
        _ => if v >= 0.5 { "On" } else { "Off" },
    }
}

extern "C" fn dispatcher(e: *mut AEffect, opcode: i32, index: i32, _value: isize, ptr: *mut c_void, opt: f32) -> isize {
    if opcode == EFF_CLOSE {
        if !e.is_null() {
            unsafe {
                let effect = Box::from_raw(e);
                if !effect.object.is_null() {
                    drop(Box::from_raw(effect.object as *mut Plugin));
                }
            }
        }
        return 1;
    }
    let Some(p) = plugin(e) else { return 0 };
    catch_unwind(AssertUnwindSafe(|| match opcode {
        EFF_GET_PARAM_NAME => { put(ptr, PARAMS.get(index as usize).copied().unwrap_or(""), 9); 1 }
        EFF_GET_PARAM_LABEL => { put(ptr, "", 9); 1 }
        EFF_GET_PARAM_DISPLAY => { put(ptr, display(index as usize, p.params[index.clamp(0, 2) as usize]), 9); 1 }
        EFF_SET_SAMPLE_RATE => { p.rate = opt; p.dsp.reset(); 0 }
        EFF_MAINS_CHANGED => { p.dsp.reset(); 0 }
        EFF_GET_PLUG_CATEGORY => CATEGORY_EFFECT,
        EFF_GET_EFFECT_NAME | EFF_GET_PRODUCT_STRING => { put(ptr, "GoXLR Studio Ren mikrofon", 64); 1 }
        EFF_GET_VENDOR_STRING => { put(ptr, "GoXLR Studio", 64); 1 }
        EFF_GET_VENDOR_VERSION => 1000,
        EFF_GET_TAIL_SIZE => FRAME as isize,
        EFF_GET_VST_VERSION => 2400,
        EFF_CAN_DO => {
            if ptr.is_null() { return 0 }
            let s = unsafe { std::ffi::CStr::from_ptr(ptr as *const c_char) }.to_string_lossy();
            if s == "plugAsChannelInsert" || s == "plugAsSend" { 1 } else { -1 }
        }
        _ => 0,
    }))
    .unwrap_or_else(|_| { p.broken = true; 0 })
}

extern "C" fn set_parameter(e: *mut AEffect, index: i32, value: f32) {
    if let Some(p) = plugin(e) {
        let r = catch_unwind(AssertUnwindSafe(|| {
            if let Some(slot) = p.params.get_mut(index as usize) {
                *slot = value.clamp(0.0, 1.0);
                p.dsp.set(Settings::from_normalized(&p.params));
            }
        }));
        if r.is_err() {
            p.broken = true;
        }
    }
}

extern "C" fn get_parameter(e: *mut AEffect, index: i32) -> f32 {
    plugin(e).and_then(|p| p.params.get(index as usize).copied()).unwrap_or(0.0)
}

/// Copies input to output untouched.
unsafe fn pass_through(inputs: *const *const f32, outputs: *mut *mut f32, frames: usize) {
    for ch in 0..2 {
        let (i, o) = (*inputs.add(ch), *outputs.add(ch));
        if !i.is_null() && !o.is_null() && i as *const f32 != o as *const f32 {
            std::ptr::copy(i, o, frames);
        }
    }
}

extern "C" fn process_replacing(e: *mut AEffect, inputs: *const *const f32, outputs: *mut *mut f32, frames: i32) {
    if inputs.is_null() || outputs.is_null() || frames <= 0 {
        return;
    }
    let n = frames as usize;
    let Some(p) = plugin(e) else { unsafe { pass_through(inputs, outputs, n) }; return };
    // Only 48 kHz is cleaned (the GoXLR's rate); anything else, or after a problem, passes through.
    if p.broken || (p.rate - RATE as f32).abs() > 1.0 {
        unsafe { pass_through(inputs, outputs, n) };
        return;
    }
    let ok = catch_unwind(AssertUnwindSafe(|| unsafe { process_block(p, inputs, outputs, n) })).is_ok();
    if !ok {
        p.broken = true;
        unsafe { pass_through(inputs, outputs, n) };
    }
}

unsafe fn process_block(p: &mut Plugin, inputs: *const *const f32, outputs: *mut *mut f32, n: usize) {
    let (il, ir) = (*inputs, *inputs.add(1));
    if p.mono.len() < n {
        p.mono.resize(n, 0.0); // only when the engine's block grows (rare, not per block)
    }
    // A mono mic gets a silent second channel from the host: then the left channel is the mic.
    let right_silent = ir.is_null() || (0..n).all(|i| *ir.add(i) == 0.0);
    for i in 0..n {
        let l = *il.add(i);
        p.mono[i] = if right_silent { l } else { 0.5 * (l + *ir.add(i)) };
    }
    // The speakers' sound that has arrived (at most 200 ms at a time).
    if let Some(r) = p.reference.as_mut() {
        loop {
            let got = r.read(&mut p.refbuf);
            if got == 0 {
                break;
            }
            p.dsp.push_render(&p.refbuf[..got]);
            if got < p.refbuf.len() {
                break;
            }
        }
    }
    let mono = &mut p.mono[..n];
    p.dsp.process(mono);
    let (ol, or) = (*outputs, *outputs.add(1));
    for (i, &v) in mono.iter().enumerate() {
        *ol.add(i) = v;
        if !or.is_null() {
            *or.add(i) = if right_silent { 0.0 } else { v };
        }
    }
    // About twice a second: tell GoXLR Studio how it is going.
    p.blocks = p.blocks.wrapping_add(1);
    if p.blocks % 50 == 0 {
        if let Some(r) = p.reference.as_mut() {
            let s = p.dsp.settings();
            let st = p.dsp.stats;
            let mut flags = crate::ring::FLAG_RUNNING;
            if s.echo { flags |= crate::ring::FLAG_AEC_ON; }
            if st.reference { flags |= crate::ring::FLAG_REFERENCE; }
            if s.noise != crate::Noise::Off { flags |= crate::ring::FLAG_NS_ON; }
            r.report(flags, st.erle_db.unwrap_or(f32::NAN), st.delay_ms.unwrap_or(-1));
        }
    }
}

extern "C" fn process_double(_: *mut AEffect, _: *const *const f64, _: *mut *mut f64, _: i32) {}

fn new_effect(reference: Option<Box<dyn Reference>>) -> *mut AEffect {
    let dsp = Cleaner::new(Settings::from_normalized(&DEFAULTS));
    let object = Box::into_raw(Box::new(Plugin {
        params: DEFAULTS,
        dsp,
        rate: RATE as f32,
        broken: false,
        reference,
        mono: vec![0.0; 4096],
        refbuf: vec![0.0; 9600],
        blocks: 0,
    })) as *mut c_void;
    Box::into_raw(Box::new(AEffect {
        magic: MAGIC,
        dispatcher,
        process: process_replacing,
        set_parameter,
        get_parameter,
        num_programs: 0,
        num_params: PARAMS.len() as i32,
        num_inputs: 2,
        num_outputs: 2,
        flags: FLAG_CAN_REPLACING,
        reserved1: 0,
        reserved2: 0,
        initial_delay: FRAME as i32,
        real_qualities: 0,
        off_qualities: 0,
        io_ratio: 1.0,
        object,
        user: std::ptr::null_mut(),
        unique_id: ID,
        version: 1000,
        process_replacing,
        process_double_replacing: process_double,
        future: [0; 56],
    }))
}

/// The plugin's entry point. The echo reference is opened here (not in the audio thread).
#[no_mangle]
pub extern "C" fn VSTPluginMain(_host: Option<HostCallback>) -> *mut AEffect {
    let reference = catch_unwind(|| {
        #[cfg(windows)]
        return crate::shm::open().map(|r| Box::new(r) as Box<dyn Reference>);
        #[cfg(not(windows))]
        None
    })
    .ok()
    .flatten();
    new_effect(reference)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    struct TestRef {
        data: Arc<Mutex<Vec<f32>>>,
        reports: Arc<Mutex<Vec<u32>>>,
    }
    impl Reference for TestRef {
        fn read(&mut self, out: &mut [f32]) -> usize {
            let mut d = self.data.lock().unwrap();
            let n = d.len().min(out.len());
            out[..n].copy_from_slice(&d[..n]);
            d.drain(..n);
            n
        }
        fn report(&mut self, flags: u32, _erle: f32, _delay: i32) {
            self.reports.lock().unwrap().push(flags);
        }
    }

    fn run(e: *mut AEffect, l: &[f32], r: &[f32]) -> (Vec<f32>, Vec<f32>) {
        let eff = unsafe { &mut *e };
        let mut ol = vec![0f32; l.len()];
        let mut or = vec![0f32; r.len()];
        let ins = [l.as_ptr(), r.as_ptr()];
        let mut outs = [ol.as_mut_ptr(), or.as_mut_ptr()];
        (eff.process_replacing)(e, ins.as_ptr(), outs.as_mut_ptr(), l.len() as i32);
        (ol, or)
    }

    #[test]
    fn host_round_trip_and_mono_mic() {
        let data = Arc::new(Mutex::new(vec![0.1f32; 4800]));
        let reports = Arc::new(Mutex::new(Vec::new()));
        let e = new_effect(Some(Box::new(TestRef { data: data.clone(), reports: reports.clone() })));
        let eff = unsafe { &mut *e };
        assert_eq!(eff.magic, MAGIC);
        assert_eq!(eff.num_params, 3);
        let mut name = [0u8; 16];
        (eff.dispatcher)(e, EFF_GET_PARAM_NAME, 1, 0, name.as_mut_ptr() as *mut c_void, 0.0);
        assert_eq!(std::ffi::CStr::from_bytes_until_nul(&name).unwrap().to_str().unwrap(), "Noise");
        (eff.dispatcher)(e, EFF_SET_SAMPLE_RATE, 0, 0, std::ptr::null_mut(), 48000.0);
        // All off: a mono mic (silent right channel) comes out on the left, one frame later, at full level.
        for i in 0..3 { (eff.set_parameter)(e, i, 0.0); }
        let l: Vec<f32> = (0..2048).map(|i| ((i as f32) * 0.05).sin() * 0.5).collect();
        let r = vec![0f32; 2048];
        let (ol, or) = run(e, &l, &r);
        assert_eq!(&ol[FRAME..], &l[..2048 - FRAME]);
        assert!(or.iter().all(|&v| v == 0.0));
        // The reference is read, and after ~50 blocks the plugin reports.
        (eff.set_parameter)(e, 0, 1.0);
        for _ in 0..60 { let _ = run(e, &l[..480], &r[..480]); }
        assert!(data.lock().unwrap().is_empty(), "reference consumed");
        let rep = reports.lock().unwrap();
        assert!(rep.iter().any(|f| f & crate::ring::FLAG_RUNNING != 0 && f & crate::ring::FLAG_AEC_ON != 0));
        drop(rep);
        (eff.dispatcher)(e, EFF_CLOSE, 0, 0, std::ptr::null_mut(), 0.0);
    }

    #[test]
    fn other_rates_pass_through_untouched() {
        let e = new_effect(None);
        let eff = unsafe { &mut *e };
        (eff.dispatcher)(e, EFF_SET_SAMPLE_RATE, 0, 0, std::ptr::null_mut(), 44100.0);
        let l: Vec<f32> = (0..1000).map(|i| (i as f32 * 0.01).sin()).collect();
        let (ol, or) = run(e, &l, &l);
        assert_eq!(ol, l);
        assert_eq!(or, l);
        (eff.dispatcher)(e, EFF_CLOSE, 0, 0, std::ptr::null_mut(), 0.0);
    }
}
