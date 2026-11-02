//! Tiny local HTTP API so Stream Deck, Home Assistant or a phone can trigger actions.
//! GET /state, GET /actions, GET|POST /action/<id>, GET /remote (the phone page); every request
//! needs the token.
use serde::Deserialize;
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

#[derive(Deserialize, Clone, Default, Debug)]
pub struct ApiConfig {
    pub enabled: bool,
    pub port: u16,
    pub lan: bool,
    pub token: String,
}

#[derive(Default)]
pub struct Api {
    generation: AtomicU64,
    pub state: Arc<Mutex<Value>>,
    pub actions: Arc<Mutex<Value>>,
}

pub fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Some(v) = std::str::from_utf8(&b[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(if b[i] == b'+' { b' ' } else { b[i] });
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    #[test]
    fn decodes() {
        assert_eq!(super::percent_decode("profile%3AHeadset"), "profile:Headset");
        assert_eq!(super::percent_decode("eq-preset%3AR%C3%B8de+1"), "eq-preset:Røde 1");
        assert_eq!(super::percent_decode("50%"), "50%");
        assert_eq!(super::percent_decode("a%2"), "a%2");
    }
}

fn respond(mut s: TcpStream, status: &str, body: &Value) {
    let text = body.to_string();
    let _ = write!(
        s,
        // Any origin may read it (the Stream Deck plugin runs from a file:// page); the token is still required.
        "HTTP/1.1 {status}\r\nContent-Type: application/json; charset=utf-8\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{text}",
        text.len()
    );
}

/// The phone remote (remote.html): it reads /state and sends /action with the same token.
const REMOTE_HTML: &str = include_str!("remote.html");

fn respond_html(mut s: TcpStream, html: &str) {
    let _ = write!(
        s,
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Security-Policy: default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{html}",
        html.len()
    );
}

/// This PC's address on the home network (for the phone link); no packet is sent.
pub fn lan_ip() -> Option<String> {
    let sock = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    sock.connect("192.0.2.1:9").ok()?;
    let ip = sock.local_addr().ok()?.ip();
    (!ip.is_loopback() && !ip.is_unspecified()).then(|| ip.to_string())
}

fn handle(app: &AppHandle, api: &Api, cfg: &ApiConfig, mut s: TcpStream) {
    let _ = s.set_read_timeout(Some(Duration::from_secs(2)));
    let mut buf = [0u8; 8192];
    let n = s.read(&mut buf).unwrap_or(0);
    let req = String::from_utf8_lossy(&buf[..n]);
    let mut lines = req.lines();
    let first = lines.next().unwrap_or("");
    let mut parts = first.split_whitespace();
    let method = parts.next().unwrap_or("");
    let target = parts.next().unwrap_or("/");
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    let header_token = lines
        .take_while(|l| !l.is_empty())
        .filter_map(|l| l.split_once(':'))
        .find(|(k, _)| k.trim().eq_ignore_ascii_case("authorization"))
        .map(|(_, v)| v.trim().trim_start_matches("Bearer ").trim().to_string());
    let query_token = query.split('&').filter_map(|kv| kv.split_once('=')).find(|(k, _)| *k == "token").map(|(_, v)| percent_decode(v));
    let token = header_token.or(query_token).unwrap_or_default();
    // CORS preflight (a page sending the token as a header asks first); answers nothing else.
    if method == "OPTIONS" {
        let head = ["HTTP/1.1 204 No Content", "Access-Control-Allow-Origin: *", "Access-Control-Allow-Methods: GET, POST", "Access-Control-Allow-Headers: Authorization", "Content-Length: 0", "Connection: close", "", ""];
        let _ = s.write_all(head.join("\r\n").as_bytes());
        return;
    }
    if cfg.token.is_empty() || token != cfg.token {
        return respond(s, "401 Unauthorized", &json!({ "error": "token mangler eller er forkert" }));
    }
    match (method, path) {
        ("GET", "/" | "") => respond(s, "200 OK", &json!({ "endpoints": ["GET /state", "GET /actions", "GET|POST /action/<id>", "GET /remote"] })),
        ("GET", "/remote") => respond_html(s, REMOTE_HTML),
        ("GET", "/state") => respond(s, "200 OK", &api.state.lock().unwrap().clone()),
        ("GET", "/actions") => respond(s, "200 OK", &api.actions.lock().unwrap().clone()),
        ("GET" | "POST", p) if p.starts_with("/action/") => {
            let id = percent_decode(&p["/action/".len()..]);
            if id.is_empty() {
                return respond(s, "400 Bad Request", &json!({ "error": "mangler handling" }));
            }
            let _ = app.emit("api-action", id.clone());
            respond(s, "200 OK", &json!({ "ok": true, "action": id }))
        }
        _ => respond(s, "404 Not Found", &json!({ "error": "ukendt sti" })),
    }
}

impl Api {
    /// (Re)starts the listener with new settings; the previous listener stops on its next poll.
    pub fn configure(self: &Arc<Self>, app: AppHandle, cfg: ApiConfig) -> Result<(), String> {
        let gen = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        if !cfg.enabled {
            return Ok(());
        }
        if cfg.token.len() < 8 {
            return Err("Token skal være mindst 8 tegn".into());
        }
        let host = if cfg.lan { "0.0.0.0" } else { "127.0.0.1" };
        // The old listener may still hold the port for one poll interval.
        let mut listener = None;
        for _ in 0..10 {
            match TcpListener::bind((host, cfg.port)) {
                Ok(l) => {
                    listener = Some(l);
                    break;
                }
                Err(_) => std::thread::sleep(Duration::from_millis(60)),
            }
        }
        let listener = listener.ok_or_else(|| format!("Port {} er optaget", cfg.port))?;
        listener.set_nonblocking(true).map_err(|e| e.to_string())?;
        let me = self.clone();
        std::thread::spawn(move || loop {
            if me.generation.load(Ordering::SeqCst) != gen {
                break;
            }
            match listener.accept() {
                Ok((s, _)) => {
                    let _ = s.set_nonblocking(false);
                    handle(&app, &me, &cfg, s);
                }
                Err(_) => std::thread::sleep(Duration::from_millis(50)),
            }
        });
        Ok(())
    }
}
