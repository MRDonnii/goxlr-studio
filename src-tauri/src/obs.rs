//! OBS: one request to OBS Studio's built-in WebSocket server (obs-websocket 5, OBS 28+; Tools →
//! WebSocket Server Settings). Each call connects, identifies (with the password when OBS asks for
//! one), sends the request and returns OBS's answer. Used to switch scenes from GoXLR Studio.
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::time::Duration;
use tokio_tungstenite::{connect_async, tungstenite::Message};

#[derive(Deserialize, Clone, Debug)]
pub struct Config {
    #[serde(default = "default_host")]
    pub host: String,
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(default)]
    pub password: String,
}

fn default_host() -> String {
    "127.0.0.1".into()
}
fn default_port() -> u16 {
    4455
}

/// obs-websocket's authentication string: base64(sha256(base64(sha256(password + salt)) + challenge)).
pub fn auth_string(password: &str, salt: &str, challenge: &str) -> String {
    let b64 = base64::engine::general_purpose::STANDARD;
    let secret = b64.encode(Sha256::digest(format!("{password}{salt}").as_bytes()));
    b64.encode(Sha256::digest(format!("{secret}{challenge}").as_bytes()))
}

/// What went wrong, in Danish.
pub fn explain(err: &str) -> String {
    let e = err.to_lowercase();
    if e.contains("refused") || e.contains("10061") {
        "OBS svarer ikke – kører OBS, og er WebSocket-serveren slået til (Værktøjer → WebSocket Server Settings)?".into()
    } else if e.contains("4009") || e.contains("authentication") {
        "OBS afviste adgangskoden – kopiér den fra OBS (Værktøjer → WebSocket Server Settings → Show Connect Info)".into()
    } else if e.contains("timed out") || e.contains("timeout") {
        "OBS svarede ikke i tide".into()
    } else {
        format!("OBS: {err}")
    }
}

pub async fn request(cfg: Config, request_type: String, data: Value) -> Result<Value, String> {
    tokio::time::timeout(Duration::from_secs(5), request_inner(cfg, request_type, data)).await.map_err(|_| explain("timeout"))?
}

async fn request_inner(cfg: Config, request_type: String, data: Value) -> Result<Value, String> {
    let host = if cfg.host.trim().is_empty() { default_host() } else { cfg.host.trim().to_string() };
    let url = format!("ws://{host}:{}", cfg.port);
    let (mut ws, _) = connect_async(url.as_str()).await.map_err(|e| explain(&e.to_string()))?;
    // Hello (op 0) → Identify (op 1) → Identified (op 2).
    let hello = loop {
        if let Some(v) = ws_next(&mut ws).await? {
            break v;
        }
    };
    let mut identify = json!({ "rpcVersion": 1 });
    if let Some(a) = hello.pointer("/d/authentication") {
        let (salt, challenge) = (a["salt"].as_str().unwrap_or_default(), a["challenge"].as_str().unwrap_or_default());
        identify["authentication"] = json!(auth_string(&cfg.password, salt, challenge));
    }
    ws.send(Message::Text(json!({ "op": 1, "d": identify }).to_string())).await.map_err(|e| explain(&e.to_string()))?;
    loop {
        let v = ws_next(&mut ws).await?.ok_or("OBS lukkede forbindelsen")?;
        if v["op"] == 2 {
            break;
        }
    }
    ws.send(Message::Text(json!({ "op": 6, "d": { "requestType": request_type, "requestId": "goxlr-studio", "requestData": data } }).to_string()))
        .await
        .map_err(|e| explain(&e.to_string()))?;
    loop {
        let v = ws_next(&mut ws).await?.ok_or("OBS lukkede forbindelsen")?;
        if v["op"] == 7 {
            let _ = ws.close(None).await;
            let st = &v["d"]["requestStatus"];
            if st["result"].as_bool() == Some(true) {
                return Ok(v["d"]["responseData"].clone());
            }
            return Err(format!("OBS: {}", st["comment"].as_str().unwrap_or("forespørgslen mislykkedes")));
        }
    }
}

type Ws = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// The next JSON message; Ok(None) for pings and the like; Err when the connection ends.
async fn ws_next(ws: &mut Ws) -> Result<Option<Value>, String> {
    match ws.next().await {
        Some(Ok(Message::Text(t))) => Ok(serde_json::from_str(&t).ok()),
        Some(Ok(Message::Close(f))) => Err(explain(&format!("lukket {}", f.map(|f| f.code.to_string() + " " + &f.reason).unwrap_or_default()))),
        Some(Ok(_)) => Ok(None),
        Some(Err(e)) => Err(explain(&e.to_string())),
        None => Err("OBS lukkede forbindelsen".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn authentication_matches_the_obs_websocket_spec() {
        // Same steps as the protocol's example: secret = b64(sha256(password + salt)), then
        // b64(sha256(secret + challenge)). Checked against an independent calculation.
        let a = auth_string("supersecretpassword", "lM1GncleQOaCu9lT1yeUZhFYnqhsLLP1G5lAGo3ixaI=", "+IxH4CnCiqpX1rM9scsNynZzbOe4KhDeYcTNS3PDaeY=");
        assert_eq!(a, "1Ct943GAT+6YQUUX47Ia/ncufilbe6+oD6lY+5kaCu4=");
        assert!(explain("Connection refused (os error 10061)").contains("WebSocket"));
        assert!(explain("closed 4009 Authentication failed").contains("adgangskoden"));
    }
}
