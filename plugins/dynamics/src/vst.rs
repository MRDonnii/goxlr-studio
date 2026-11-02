//! The VST 2.4 plugin ABI – only the plain C structures and numbers a host uses (like the vst-rs
//! crate, no Steinberg SDK). Equalizer APO loads the DLL, calls `VSTPluginMain`, sets parameters by
//! name and calls `processReplacing` with the audio.
use crate::{Dynamics, Settings, DEFAULTS, PARAMS};
use std::ffi::c_void;
use std::os::raw::c_char;

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
const ID: i32 = i32::from_be_bytes(*b"GXdy");

// Dispatcher opcodes.
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

struct Plugin {
    params: [f32; 8],
    dsp: Dynamics,
}

fn plugin<'a>(e: *mut AEffect) -> Option<&'a mut Plugin> {
    unsafe { e.as_mut().and_then(|e| (e.object as *mut Plugin).as_mut()) }
}

/// Copies a string into the host's buffer (at most `max` bytes including the terminating 0).
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

fn display(index: usize, v: f32) -> (String, &'static str) {
    use crate::map::*;
    match index {
        0 => (format!("{:.1}", threshold_db(v)), "dB"),
        1 => (format!("{:.1}", ratio(v)), ":1"),
        2 => (format!("{:.1}", attack_ms(v)), "ms"),
        3 => (format!("{:.0}", release_ms(v)), "ms"),
        4 => (format!("{:.1}", makeup_db(v)), "dB"),
        5 => ((if v >= 0.5 { "On" } else { "Off" }).to_string(), ""),
        6 => (format!("{:.1}", ceiling_db(v)), "dB"),
        _ => (format!("{:.0}", lim_release_ms(v)), "ms"),
    }
}

extern "C" fn dispatcher(e: *mut AEffect, opcode: i32, index: i32, _value: isize, ptr: *mut c_void, opt: f32) -> isize {
    let Some(p) = plugin(e) else { return 0 };
    match opcode {
        EFF_CLOSE => {
            unsafe {
                let effect = Box::from_raw(e);
                drop(Box::from_raw(effect.object as *mut Plugin));
            }
            1
        }
        EFF_GET_PARAM_NAME => { put(ptr, PARAMS.get(index as usize).copied().unwrap_or(""), 9); 1 }
        EFF_GET_PARAM_LABEL => { put(ptr, display(index as usize, p.params[index.clamp(0, 7) as usize]).1, 9); 1 }
        EFF_GET_PARAM_DISPLAY => { put(ptr, &display(index as usize, p.params[index.clamp(0, 7) as usize]).0, 9); 1 }
        EFF_SET_SAMPLE_RATE => {
            p.dsp.set_rate(opt);
            unsafe { (*e).initial_delay = p.dsp.latency() as i32 };
            0
        }
        EFF_MAINS_CHANGED => { p.dsp.reset(); 0 }
        EFF_GET_PLUG_CATEGORY => CATEGORY_EFFECT,
        EFF_GET_EFFECT_NAME | EFF_GET_PRODUCT_STRING => { put(ptr, "GoXLR Studio Dynamik", 64); 1 }
        EFF_GET_VENDOR_STRING => { put(ptr, "GoXLR Studio", 64); 1 }
        EFF_GET_VENDOR_VERSION => 1000,
        EFF_GET_TAIL_SIZE => p.dsp.latency() as isize,
        EFF_GET_VST_VERSION => 2400,
        EFF_CAN_DO => {
            if ptr.is_null() { return 0 }
            let s = unsafe { std::ffi::CStr::from_ptr(ptr as *const c_char) }.to_string_lossy();
            if s == "plugAsChannelInsert" || s == "plugAsSend" { 1 } else { -1 }
        }
        _ => 0,
    }
}

extern "C" fn set_parameter(e: *mut AEffect, index: i32, value: f32) {
    if let Some(p) = plugin(e) {
        if let Some(slot) = p.params.get_mut(index as usize) {
            *slot = value.clamp(0.0, 1.0);
            p.dsp.set(Settings::from_normalized(&p.params));
        }
    }
}

extern "C" fn get_parameter(e: *mut AEffect, index: i32) -> f32 {
    plugin(e).and_then(|p| p.params.get(index as usize).copied()).unwrap_or(0.0)
}

extern "C" fn process_replacing(e: *mut AEffect, inputs: *const *const f32, outputs: *mut *mut f32, frames: i32) {
    let Some(p) = plugin(e) else { return };
    if inputs.is_null() || outputs.is_null() || frames <= 0 {
        return;
    }
    unsafe {
        let (il, ir) = (*inputs, *inputs.add(1));
        let (ol, or) = (*outputs, *outputs.add(1));
        for i in 0..frames as usize {
            let (l, r) = p.dsp.process_frame(*il.add(i), *ir.add(i));
            *ol.add(i) = l;
            *or.add(i) = r;
        }
    }
}

extern "C" fn process_double(_: *mut AEffect, _: *const *const f64, _: *mut *mut f64, _: i32) {}

/// The plugin's entry point (the host passes its callback, which this plugin does not need).
#[no_mangle]
pub extern "C" fn VSTPluginMain(_host: Option<HostCallback>) -> *mut AEffect {
    let mut dsp = Dynamics::new(48000.0);
    dsp.set(Settings::from_normalized(&DEFAULTS));
    let latency = dsp.latency() as i32;
    let object = Box::into_raw(Box::new(Plugin { params: DEFAULTS, dsp })) as *mut c_void;
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
        initial_delay: latency,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_round_trip() {
        let e = VSTPluginMain(None);
        let eff = unsafe { &mut *e };
        assert_eq!(eff.magic, MAGIC);
        assert_eq!(eff.num_params, 8);
        let mut name = [0u8; 64];
        (eff.dispatcher)(e, EFF_GET_PARAM_NAME, 6, 0, name.as_mut_ptr() as *mut c_void, 0.0);
        assert_eq!(std::ffi::CStr::from_bytes_until_nul(&name).unwrap().to_str().unwrap(), "Ceiling");
        (eff.dispatcher)(e, EFF_SET_SAMPLE_RATE, 0, 0, std::ptr::null_mut(), 44100.0);
        (eff.set_parameter)(e, 6, 0.5); // ceiling −6 dB
        assert_eq!((eff.get_parameter)(e, 6), 0.5);
        let inl = vec![1.0f32; 512];
        let inr = vec![-1.0f32; 512];
        let mut outl = vec![0f32; 512];
        let mut outr = vec![0f32; 512];
        let ins = [inl.as_ptr(), inr.as_ptr()];
        let mut outs = [outl.as_mut_ptr(), outr.as_mut_ptr()];
        (eff.process_replacing)(e, ins.as_ptr(), outs.as_mut_ptr(), 512);
        let ceil = db_to_lin_test(-6.0);
        assert!(outl.iter().chain(outr.iter()).all(|v| v.abs() <= ceil * 1.0001));
        assert!(outl[500] > 0.4);
        (eff.dispatcher)(e, EFF_CLOSE, 0, 0, std::ptr::null_mut(), 0.0);
    }

    fn db_to_lin_test(db: f32) -> f32 { crate::db_to_lin(db) }
}
