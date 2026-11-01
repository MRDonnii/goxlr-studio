//! TC-Helicon's GoXLR driver: it turns the GoXLR into a sound card in Windows, and the GoXLR engine
//! talks to the GoXLR through its API DLL. GoXLR Studio may not ship or install it (TC-Helicon's
//! licence) and never changes or removes it – it only checks that it is there (the same way the
//! engine finds it) and points to TC-Helicon's official download when it is missing.
use serde::Serialize;

/// The driver's API, registered as a COM class by TC-Helicon's installer.
const API_CLSID: &str = r"CLSID\{024D0372-641F-4B7B-8140-F4DFE458C982}\InprocServer32";
/// Where the engine looks when the registration is missing.
const API_DEFAULT: &str = r"C:\Program Files\TC-HELICON\GoXLR_Audio_Driver\W10_x64\goxlr_audioapi_x64.dll";

/// TC-Helicon's product pages with the driver under Downloads.
pub const DOWNLOAD_MINI: &str = "https://www.tchelicon.com/en/products/0803-AAB";
pub const DOWNLOAD_FULL: &str = "https://www.tchelicon.com/en/products/0803-AAA";

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct DriverInfo {
    pub installed: bool,
    /// The driver's API DLL, when found.
    pub api: Option<String>,
    pub download_mini: &'static str,
    pub download_full: &'static str,
}

/// Pure: the API DLL from the registered path (if that file exists) or the default path.
pub fn locate(registered: Option<String>, exists: impl Fn(&str) -> bool) -> Option<String> {
    registered.filter(|p| !p.is_empty() && exists(p)).or_else(|| exists(API_DEFAULT).then(|| API_DEFAULT.to_string()))
}

pub fn info() -> DriverInfo {
    let api = locate(crate::deck::hkcr_default(API_CLSID), |p| std::path::Path::new(p).exists());
    DriverInfo { installed: api.is_some(), api, download_mini: DOWNLOAD_MINI, download_full: DOWNLOAD_FULL }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_driver_like_the_engine_does() {
        let reg = Some(r"D:\TC\goxlr_audioapi_x64.dll".to_string());
        assert_eq!(locate(reg.clone(), |_| true).as_deref(), Some(r"D:\TC\goxlr_audioapi_x64.dll"));
        // Registered but the file is gone: fall back to the default place.
        assert_eq!(locate(reg.clone(), |p| p == API_DEFAULT).as_deref(), Some(API_DEFAULT));
        assert_eq!(locate(None, |p| p == API_DEFAULT).as_deref(), Some(API_DEFAULT));
        assert_eq!(locate(reg, |_| false), None);
        assert_eq!(locate(Some(String::new()), |_| false), None);
    }
}
