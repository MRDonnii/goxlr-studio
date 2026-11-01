use serde::Serialize;

#[derive(Serialize, Clone, Debug)]
pub struct AudioDevice {
    pub id: String,
    pub name: String,
    pub flow: &'static str,
    pub default: bool,
    pub default_comm: bool,
}

#[cfg(windows)]
#[allow(non_snake_case)]
mod imp {
    use super::AudioDevice;
    use std::ffi::c_void;
    #[allow(unused_imports)]
    use windows::core::{interface, IUnknown, IUnknown_Vtbl, Interface, GUID, HRESULT, PCWSTR, PWSTR};
    use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
    use windows::Win32::Media::Audio::{
        eCapture, eCommunications, eConsole, eMultimedia, eRender, EDataFlow, ERole, IMMDevice, IMMDeviceEnumerator,
        MMDeviceEnumerator, DEVICE_STATE_ACTIVE,
    };
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_ALL, COINIT_MULTITHREADED, STGM_READ};

    // Undocumented but stable since Windows 7; used by every default-device switcher.
    #[interface("f8679f50-850a-41cf-9c72-430f290290c8")]
    unsafe trait IPolicyConfig: IUnknown {
        fn GetMixFormat(&self, a: PCWSTR, b: *mut *mut c_void) -> HRESULT;
        fn GetDeviceFormat(&self, a: PCWSTR, b: i32, c: *mut *mut c_void) -> HRESULT;
        fn ResetDeviceFormat(&self, a: PCWSTR) -> HRESULT;
        fn SetDeviceFormat(&self, a: PCWSTR, b: *mut c_void, c: *mut c_void) -> HRESULT;
        fn GetProcessingPeriod(&self, a: PCWSTR, b: i32, c: *mut i64, d: *mut i64) -> HRESULT;
        fn SetProcessingPeriod(&self, a: PCWSTR, b: *mut i64) -> HRESULT;
        fn GetShareMode(&self, a: PCWSTR, b: *mut c_void) -> HRESULT;
        fn SetShareMode(&self, a: PCWSTR, b: *mut c_void) -> HRESULT;
        fn GetPropertyValue(&self, a: PCWSTR, b: *const c_void, c: *mut c_void) -> HRESULT;
        fn SetPropertyValue(&self, a: PCWSTR, b: *const c_void, c: *const c_void) -> HRESULT;
        fn SetDefaultEndpoint(&self, id: PCWSTR, role: ERole) -> HRESULT;
        fn SetEndpointVisibility(&self, id: PCWSTR, visible: i32) -> HRESULT;
    }
    const CLSID_POLICY_CONFIG: GUID = GUID::from_u128(0x870af99c_171d_4f9e_af0d_e63df40c2bc9);

    fn com_init() {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
    }

    unsafe fn pwstr_take(p: PWSTR) -> String {
        let s = p.to_string().unwrap_or_default();
        CoTaskMemFree(Some(p.0 as *const c_void));
        s
    }

    unsafe fn device_id(d: &IMMDevice) -> windows::core::Result<String> {
        Ok(pwstr_take(d.GetId()?))
    }

    unsafe fn default_id(en: &IMMDeviceEnumerator, flow: EDataFlow, role: ERole) -> Option<String> {
        en.GetDefaultAudioEndpoint(flow, role).ok().and_then(|d| device_id(&d).ok())
    }

    pub fn list() -> Result<Vec<AudioDevice>, String> {
        com_init();
        unsafe {
            let en: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(|e| e.to_string())?;
            let mut out = Vec::new();
            for (flow, name) in [(eRender, "render"), (eCapture, "capture")] {
                let def = default_id(&en, flow, eConsole);
                let def_comm = default_id(&en, flow, eCommunications);
                let col = en.EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE).map_err(|e| e.to_string())?;
                for i in 0..col.GetCount().map_err(|e| e.to_string())? {
                    let Ok(dev) = col.Item(i) else { continue };
                    let Ok(id) = device_id(&dev) else { continue };
                    let friendly = dev
                        .OpenPropertyStore(STGM_READ)
                        .and_then(|s| s.GetValue(&PKEY_Device_FriendlyName))
                        .map(|v| v.to_string())
                        .unwrap_or_else(|_| id.clone());
                    out.push(AudioDevice {
                        default: def.as_deref() == Some(id.as_str()),
                        default_comm: def_comm.as_deref() == Some(id.as_str()),
                        id,
                        name: friendly,
                        flow: name,
                    });
                }
            }
            Ok(out)
        }
    }

    pub fn set_default(id: &str, role: &str) -> Result<(), String> {
        com_init();
        let roles: &[ERole] = match role {
            "console" => &[eConsole, eMultimedia],
            "comm" => &[eCommunications],
            _ => &[eConsole, eMultimedia, eCommunications],
        };
        let wide: Vec<u16> = id.encode_utf16().chain(std::iter::once(0)).collect();
        unsafe {
            let unk: IUnknown = CoCreateInstance(&CLSID_POLICY_CONFIG, None, CLSCTX_ALL).map_err(|e| e.to_string())?;
            let pc: IPolicyConfig = unk.cast().map_err(|e| e.to_string())?;
            for r in roles {
                pc.SetDefaultEndpoint(PCWSTR(wide.as_ptr()), *r).ok().map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    }

    pub fn name_of(id: &str) -> Option<String> {
        list().ok()?.into_iter().find(|d| d.id == id).map(|d| d.name)
    }
}

#[cfg(not(windows))]
mod imp {
    use super::AudioDevice;
    pub fn list() -> Result<Vec<AudioDevice>, String> {
        Ok(Vec::new())
    }
    pub fn set_default(_id: &str, _role: &str) -> Result<(), String> {
        Err("Skift af lydenhed understøttes kun på Windows".into())
    }
    pub fn name_of(_id: &str) -> Option<String> {
        None
    }
}

pub use imp::{list, name_of, set_default};
