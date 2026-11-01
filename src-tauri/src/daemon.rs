use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio_tungstenite::{connect_async, tungstenite::Message};

/// The GoXLR Utility daemon tags broadcast patches with this id.
const PATCH_ID: u64 = u64::MAX;

#[derive(Clone, Default)]
pub struct Daemon {
    inner: Arc<Inner>,
}

#[derive(Default)]
struct Inner {
    tx: Mutex<Option<mpsc::UnboundedSender<Message>>>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Value>>>,
    next_id: AtomicU64,
    connected: AtomicBool,
}

impl Daemon {
    pub fn connected(&self) -> bool {
        self.inner.connected.load(Ordering::SeqCst)
    }

    pub async fn request(&self, data: Value) -> Result<Value, String> {
        let sender = self
            .inner
            .tx
            .lock()
            .await
            .clone()
            .ok_or_else(|| "GoXLR Utility kører ikke".to_string())?;
        let id = self.inner.next_id.fetch_add(1, Ordering::SeqCst) + 1;
        let (tx, rx) = oneshot::channel();
        self.inner.pending.lock().await.insert(id, tx);
        let msg = json!({ "id": id, "data": data }).to_string();
        if sender.send(Message::Text(msg)).is_err() {
            self.inner.pending.lock().await.remove(&id);
            return Err("Forbindelsen til GoXLR Utility er lukket".into());
        }
        match tokio::time::timeout(Duration::from_secs(5), rx).await {
            Ok(Ok(v)) => Ok(v),
            _ => {
                self.inner.pending.lock().await.remove(&id);
                Err("GoXLR Utility svarede ikke".into())
            }
        }
    }

    pub fn spawn(self, app: AppHandle, url: String) {
        tauri::async_runtime::spawn(async move {
            loop {
                if let Ok((ws, _)) = connect_async(url.as_str()).await {
                    self.run_connection(&app, ws).await;
                }
                tokio::time::sleep(Duration::from_secs(3)).await;
            }
        });
    }

    async fn run_connection(
        &self,
        app: &AppHandle,
        ws: tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    ) {
        let (mut write, mut read) = ws.split();
        let (tx, mut rx) = mpsc::unbounded_channel::<Message>();
        *self.inner.tx.lock().await = Some(tx);
        self.inner.connected.store(true, Ordering::SeqCst);
        let _ = app.emit("daemon-connection", true);

        let writer = tauri::async_runtime::spawn(async move {
            while let Some(m) = rx.recv().await {
                if write.send(m).await.is_err() {
                    break;
                }
            }
        });

        while let Some(Ok(msg)) = read.next().await {
            let Message::Text(text) = msg else { continue };
            let Ok(mut v) = serde_json::from_str::<Value>(&text) else { continue };
            let id = v["id"].as_u64().unwrap_or(0);
            let data = v["data"].take();
            if id == PATCH_ID {
                if let Some(patch) = data.get("Patch") {
                    let _ = app.emit("daemon-patch", patch);
                }
            } else if let Some(waiter) = self.inner.pending.lock().await.remove(&id) {
                let _ = waiter.send(data);
            }
        }

        writer.abort();
        *self.inner.tx.lock().await = None;
        self.inner.pending.lock().await.clear();
        self.inner.connected.store(false, Ordering::SeqCst);
        let _ = app.emit("daemon-connection", false);
    }
}
