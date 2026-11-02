//! Eget FIR-filter: an impulse response (WAV) the user made in REW, rePhase, DRC … is copied into the
//! EQ engine's config folder and used with "Convolution:" – only at its own sample rate (an
//! `If: sampleRate == …` around it), because Equalizer APO cannot use a file of another rate.
use base64::Engine;
use serde::Serialize;

#[derive(Serialize, Debug, PartialEq)]
pub struct WavInfo {
    pub file: String,
    pub rate: u32,
    pub channels: u16,
    pub frames: u32,
}

/// Sample rate, channels and length of a WAV, or why it cannot be used.
pub fn wav_info(bytes: &[u8]) -> Result<(u32, u16, u32), String> {
    if bytes.len() < 44 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err("Filen er ikke en WAV-fil".into());
    }
    let (mut pos, mut fmt, mut data) = (12usize, None, None);
    while pos + 8 <= bytes.len() {
        let id = &bytes[pos..pos + 4];
        let len = u32::from_le_bytes([bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]]) as usize;
        let body = pos + 8;
        if id == b"fmt " && body + 16 <= bytes.len() {
            let ch = u16::from_le_bytes([bytes[body + 2], bytes[body + 3]]);
            let rate = u32::from_le_bytes([bytes[body + 4], bytes[body + 5], bytes[body + 6], bytes[body + 7]]);
            let align = u16::from_le_bytes([bytes[body + 12], bytes[body + 13]]);
            fmt = Some((rate, ch, align));
        } else if id == b"data" {
            data = Some(len.min(bytes.len().saturating_sub(body)));
        }
        pos = body + len + (len & 1);
    }
    let (rate, ch, align) = fmt.ok_or("WAV-filen mangler sit format")?;
    let data = data.ok_or("WAV-filen har ingen lyd")?;
    if ch == 0 || ch > 8 || align == 0 || !(8000..=384000).contains(&rate) {
        return Err("WAV-filens format kendes ikke".into());
    }
    Ok((rate, ch, (data / align as usize) as u32))
}

/// A file name that is safe in the config folder and in a "Convolution:" line.
pub fn safe_name(name: &str) -> String {
    let stem: String = name.trim_end_matches(".wav").trim_end_matches(".WAV").chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' }).collect();
    let stem = stem.trim_matches('-');
    format!("fir-{}.wav", if stem.is_empty() { "filter" } else { &stem[..stem.len().min(40)] })
}

pub fn save(name: &str, data_b64: &str) -> Result<WavInfo, String> {
    let bytes = base64::engine::general_purpose::STANDARD.decode(data_b64).map_err(|e| e.to_string())?;
    if bytes.len() > 32 * 1024 * 1024 {
        return Err("Filen er for stor (højst 32 MB)".into());
    }
    let (rate, channels, frames) = wav_info(&bytes)?;
    let dir = crate::engine::config_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file = safe_name(name);
    std::fs::write(dir.join(&file), &bytes).map_err(|e| e.to_string())?;
    Ok(WavInfo { file, rate, channels, frames })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_wav_header_and_names() {
        let w = crate::clips::wav16(&[0.0; 200], 48000);
        assert_eq!(wav_info(&w).unwrap(), (48000, 2, 100));
        assert!(wav_info(b"not a wav file at all, just some bytes padded out to length").is_err());
        assert_eq!(safe_name("Min rumkorrektion 48k.wav"), "fir-Min-rumkorrektion-48k.wav");
        assert_eq!(safe_name("../../x"), "fir-x.wav");
        assert_eq!(safe_name("æøå"), "fir-filter.wav");
    }
}
