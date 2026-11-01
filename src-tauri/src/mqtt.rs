//! Home Assistant via MQTT. GoXLR Studio connects to the user's MQTT broker (e.g. the Mosquitto
//! add-on in Home Assistant); the UI announces its entities with Home Assistant's MQTT discovery
//! and publishes their state (public/js/mqtt.js). Messages on the command topics reach the UI as
//! the event `mqtt-command`. Plain MQTT on the home network (port 1883), no TLS.
use rumqttc::{AsyncClient, Event, LastWill, MqttOptions, Packet, QoS};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

#[derive(Deserialize, Clone, Debug)]
pub struct Config {
    /// "homeassistant.local", "192.168.1.10:1883" or "mqtt://ha:1883".
    pub host: String,
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(default)]
    pub user: String,
    #[serde(default)]
    pub password: String,
    /// This GoXLR Studio's own topics, e.g. "goxlr-studio/goxlr-a1b2c3".
    pub base: String,
    pub client_id: String,
}

fn default_port() -> u16 {
    1883
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct Status {
    pub enabled: bool,
    pub connected: bool,
    pub broker: String,
    pub error: Option<String>,
}

#[derive(Deserialize, Debug)]
pub struct Message {
    pub topic: String,
    pub payload: String,
    #[serde(default)]
    pub retain: bool,
}

#[derive(Serialize, Clone, Debug)]
pub struct Command {
    pub topic: String,
    pub payload: String,
}

struct Conn {
    client: AsyncClient,
    task: tauri::async_runtime::JoinHandle<()>,
    base: String,
}

static CONN: Mutex<Option<Conn>> = Mutex::new(None);
static STATUS: Mutex<Option<Status>> = Mutex::new(None);

fn set_status(app: &AppHandle, f: impl FnOnce(&mut Status)) {
    let s = {
        let mut g = STATUS.lock().unwrap();
        let s = g.get_or_insert_with(Status::default);
        f(s);
        s.clone()
    };
    let _ = app.emit("mqtt-status", s);
}

pub fn status() -> Status {
    STATUS.lock().unwrap().clone().unwrap_or_default()
}

/// The broker address the way people type it.
pub fn parse_host(input: &str, port: u16) -> Result<(String, u16), String> {
    let s = input.trim();
    let s = s.strip_prefix("mqtt://").or_else(|| s.strip_prefix("tcp://")).unwrap_or(s).trim_end_matches('/');
    if s.is_empty() {
        return Err("Skriv adressen på din MQTT-broker, fx homeassistant.local".into());
    }
    if s.contains("://") {
        return Err("Kun almindelig MQTT (mqtt://, port 1883) understøttes – ikke TLS eller websockets".into());
    }
    match s.rsplit_once(':') {
        // One colon: host:port. More (an IPv6 address): no port in the text.
        Some((h, p)) if !h.contains(':') => {
            let p: u16 = p.parse().map_err(|_| format!("Ugyldig port: {p}"))?;
            Ok((h.to_string(), p))
        }
        _ => Ok((s.to_string(), port)),
    }
}

/// A connection error in Danish, with what to check.
pub fn explain(err: &str, broker: &str) -> String {
    let e = err.to_lowercase();
    if e.contains("badusernamepassword") || e.contains("notauthorized") || e.contains("not authorized") {
        format!("{broker} afviste brugernavn eller adgangskode. Brug en bruger fra Home Assistant (Indstillinger → Personer) eller Mosquittos login.")
    } else if e.contains("10061") || e.contains("connection refused") {
        format!("{broker} svarer ikke. Kører Mosquitto-tilføjelsen, og er adressen og porten (1883) rigtige?")
    } else if e.contains("10060") || e.contains("timed out") || e.contains("timeout") {
        format!("Ingen forbindelse til {broker} (timeout). Er pc'en på samme netværk, og lukker en firewall for port 1883?")
    } else if e.contains("lookup") || e.contains("no such host") || e.contains("11001") || e.contains("dns") {
        format!("Kunne ikke finde {broker}. Prøv Home Assistants IP-adresse i stedet, fx 192.168.1.10.")
    } else {
        format!("{broker}: {err}")
    }
}

pub fn start(app: AppHandle, cfg: Config) -> Result<(), String> {
    stop();
    let (host, port) = parse_host(&cfg.host, cfg.port)?;
    let mut opts = MqttOptions::new(cfg.client_id.clone(), host.clone(), port);
    opts.set_keep_alive(Duration::from_secs(30));
    // Discovery messages are a few KB each.
    opts.set_max_packet_size(256 * 1024, 256 * 1024);
    if !cfg.user.is_empty() {
        opts.set_credentials(cfg.user.clone(), cfg.password.clone());
    }
    // Home Assistant shows the entities as unavailable when the app is gone.
    opts.set_last_will(LastWill::new(format!("{}/status", cfg.base), "offline", QoS::AtLeastOnce, true));
    let (client, mut events) = AsyncClient::new(opts, 200);
    let broker = format!("{host}:{port}");
    set_status(&app, |s| {
        *s = Status { enabled: true, connected: false, broker: broker.clone(), error: None };
    });
    let (c, base) = (client.clone(), cfg.base.clone());
    let task = tauri::async_runtime::spawn(async move {
        loop {
            match events.poll().await {
                Ok(Event::Incoming(Packet::ConnAck(_))) => {
                    let _ = c.subscribe(format!("{base}/+/set"), QoS::AtLeastOnce).await;
                    // Home Assistant says "online" when it (re)starts: then everything is announced again.
                    let _ = c.subscribe("homeassistant/status", QoS::AtLeastOnce).await;
                    let _ = c.publish(format!("{base}/status"), QoS::AtLeastOnce, true, "online").await;
                    set_status(&app, |s| {
                        s.connected = true;
                        s.error = None;
                    });
                    let _ = app.emit("mqtt-connected", ());
                }
                Ok(Event::Incoming(Packet::Publish(p))) => {
                    let _ = app.emit("mqtt-command", Command { topic: p.topic.clone(), payload: String::from_utf8_lossy(&p.payload).into_owned() });
                }
                Ok(_) => {}
                Err(e) => {
                    let text = explain(&format!("{e:?} {e}"), &broker);
                    set_status(&app, |s| {
                        s.connected = false;
                        s.error = Some(text);
                    });
                    // The next poll connects again.
                    tokio::time::sleep(Duration::from_secs(5)).await;
                }
            }
        }
    });
    *CONN.lock().unwrap() = Some(Conn { client, task, base: cfg.base });
    Ok(())
}

/// Queues messages without waiting (never blocks the UI, also while the broker is away).
pub fn publish(messages: Vec<Message>) -> Result<usize, String> {
    let client = CONN.lock().unwrap().as_ref().map(|c| c.client.clone()).ok_or("MQTT er ikke slået til")?;
    let mut n = 0;
    for m in messages {
        if client.try_publish(m.topic, QoS::AtLeastOnce, m.retain, m.payload).is_ok() {
            n += 1;
        }
    }
    Ok(n)
}

/// Says "offline" (so Home Assistant shows the entities as unavailable) and disconnects.
pub fn stop() {
    if let Some(c) = CONN.lock().unwrap().take() {
        let _ = c.client.try_publish(format!("{}/status", c.base), QoS::AtLeastOnce, true, "offline");
        let _ = c.client.try_disconnect();
        let task = c.task;
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(800)).await;
            task.abort();
        });
    }
    if let Some(s) = STATUS.lock().unwrap().as_mut() {
        s.enabled = false;
        s.connected = false;
        s.error = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn broker_addresses_as_people_type_them() {
        assert_eq!(parse_host("homeassistant.local", 1883).unwrap(), ("homeassistant.local".into(), 1883));
        assert_eq!(parse_host(" 192.168.1.10:1884 ", 1883).unwrap(), ("192.168.1.10".into(), 1884));
        assert_eq!(parse_host("mqtt://ha.lan:1883/", 1).unwrap(), ("ha.lan".into(), 1883));
        assert_eq!(parse_host("fe80::1", 1883).unwrap(), ("fe80::1".into(), 1883));
        assert!(parse_host("", 1883).is_err());
        assert!(parse_host("ws://ha:8123", 1883).is_err());
        assert!(parse_host("ha:abc", 1883).is_err());
    }

    #[test]
    fn errors_say_what_to_check() {
        assert!(explain("ConnectionRefused(BadUserNamePassword)", "ha:1883").contains("adgangskode"));
        assert!(explain("Io(Os { code: 10061 })", "ha:1883").contains("Mosquitto"));
        assert!(explain("connection timed out", "ha:1883").contains("timeout"));
        assert!(explain("failed to lookup address information", "ha.local:1883").contains("IP-adresse"));
        assert_eq!(explain("odd", "ha:1883"), "ha:1883: odd");
    }
}
