import { createDemoStatus, applyDemoCommand, applyDemoDaemon } from './demo.js';

function unescapePointer(seg) {
  return seg.replace(/~1/g, '/').replace(/~0/g, '~');
}

export function applyPatch(doc, ops) {
  for (const op of ops) {
    const parts = op.path.split('/').slice(1).map(unescapePointer);
    const key = parts.pop();
    let parent = doc;
    for (const p of parts) parent = parent[p];
    if (op.op === 'remove') {
      if (Array.isArray(parent)) parent.splice(Number(key), 1);
      else delete parent[key];
    } else if (op.op === 'add' && Array.isArray(parent)) {
      if (key === '-') parent.push(op.value);
      else parent.splice(Number(key), 0, op.value);
    } else if (op.op === 'add' || op.op === 'replace') {
      parent[key] = op.value;
    }
  }
}

// GoXLR Utility's commands are a Rust enum, and serde writes them as JSON like this:
//   Name()        → {"Name": []}
//   Name(value)   → {"Name": value}      (one value is NOT wrapped in a list)
//   Name(a, b, …) → {"Name": [a, b, …]}
// Before 0.4.6 one value was sent as a list, so e.g. SetSwearButtonVolume and SetCoughMuteState
// failed with "invalid type: sequence, expected i8".
export function commandJson(name, args) {
  return { [name]: args.length === 1 ? args[0] : args };
}

export class GoXLRConnection extends EventTarget {
  constructor() {
    super();
    this.status = null;
    this.mode = 'connecting';
    this.serial = null;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.retryTimer = null;
    this.transport = null;
    this.connected = false;
    this.loading = false;
  }

  get mixer() {
    return this.status && this.serial ? this.status.mixers[this.serial] : null;
  }

  emit() {
    this.dispatchEvent(new Event('change'));
  }

  start() {
    if (window.__TAURI__) this.startTauri();
    else this.connect();
  }

  async startTauri() {
    const { invoke } = window.__TAURI__.core;
    const { listen } = window.__TAURI__.event;
    this.transport = (data) => invoke('daemon_request', { data }).catch((e) => ({ Error: String(e) }));
    await listen('daemon-patch', (ev) => {
      if (this.status && this.mode === 'live') {
        applyPatch(this.status, ev.payload);
        this.pickSerial();
        this.emit();
      }
    });
    await listen('daemon-connection', (ev) => this.onConnection(ev.payload));
    this.onConnection(await invoke('daemon_connected'));
  }

  // The app's connection to the engine changed. Connected: fetch the status – and keep trying until
  // it comes (right after a start the engine can answer before it is ready; before, one failed
  // GetStatus left the app showing the demo while the sliders' commands went nowhere).
  async onConnection(connected) {
    this.connected = connected;
    if (!connected) {
      if (this.mode !== 'demo') this.enterDemo();
      return;
    }
    if (this.loading) return;
    this.loading = true;
    try {
      for (let i = 0; this.connected; i++) {
        const res = await this.request('GetStatus');
        if (res && res.Status) {
          this.status = res.Status;
          this.mode = 'live';
          this.pickSerial();
          this.emit();
          return;
        }
        await new Promise((r) => setTimeout(r, Math.min(5000, 300 * 2 ** i)));
      }
    } finally {
      this.loading = false;
    }
  }

  connect() {
    clearTimeout(this.retryTimer);
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    let ws;
    try {
      ws = new WebSocket(`${proto}://${location.host}/api/websocket`);
    } catch {
      this.enterDemo();
      return;
    }
    this.ws = ws;
    this.transport = (data) => new Promise((resolve) => {
      if (ws.readyState !== WebSocket.OPEN) { resolve({ Error: 'not connected' }); return; }
      const id = this.nextId++;
      this.pending.set(id, resolve);
      ws.send(JSON.stringify({ id, data }));
    });
    const failTimer = setTimeout(() => ws.close(), 2500);
    ws.onopen = async () => {
      clearTimeout(failTimer);
      const res = await this.request('GetStatus');
      if (res && res.Status) {
        this.status = res.Status;
        this.mode = 'live';
        this.pickSerial();
        this.emit();
      } else {
        ws.close();
      }
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.data && msg.data.Patch) {
        if (this.status && this.mode === 'live') {
          applyPatch(this.status, msg.data.Patch);
          this.pickSerial();
          this.emit();
        }
        return;
      }
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        p(msg.data);
      }
    };
    ws.onclose = () => {
      clearTimeout(failTimer);
      for (const p of this.pending.values()) p({ Error: 'disconnected' });
      this.pending.clear();
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.mode !== 'demo') this.enterDemo();
      this.retryTimer = setTimeout(() => this.connect(), 5000);
    };
  }

  enterDemo() {
    if (this.mode === 'demo') return;
    this.mode = 'demo';
    this.status = createDemoStatus();
    this.pickSerial();
    this.emit();
  }

  pickSerial() {
    const serials = Object.keys(this.status?.mixers || {});
    if (!serials.includes(this.serial)) this.serial = serials[0] || null;
  }

  request(data) {
    return this.transport ? this.transport(data) : Promise.resolve({ Error: 'not connected' });
  }

  async command(name, ...args) {
    // In the Windows app a command must reach the GoXLR – never vanish into the demo in silence.
    if (window.__TAURI__ && (this.mode !== 'live' || !this.serial)) {
      const why = this.mode !== 'live' ? 'ikke forbundet til GoXLR-motoren' : 'ingen GoXLR fundet';
      this.dispatchEvent(new CustomEvent('error', { detail: `${name}: ${why} – ændringen blev ikke sendt` }));
      if (this.connected && this.mode !== 'live') this.onConnection(true);
      return;
    }
    if (!this.serial) return;
    if (this.mode === 'demo') {
      applyDemoCommand(this.status, this.serial, { [name]: args });
      this.emit();
      return;
    }
    const res = await this.request({ Command: [this.serial, commandJson(name, args)] });
    if (res && res.Error) this.dispatchEvent(new CustomEvent('error', { detail: `${name}: ${res.Error}` }));
  }

  /** A command to the engine itself (DaemonCommand in GoXLR Utility), e.g. SetTTSEnabled. */
  async daemon(name, ...args) {
    if (this.mode === 'demo') {
      applyDemoDaemon(this.status, { [name]: args });
      this.emit();
      return;
    }
    // A variant without values (e.g. ApplySampleChange) is just its name in serde's JSON.
    const res = await this.request({ Daemon: args.length ? commandJson(name, args) : name });
    if (res && res.Error) this.dispatchEvent(new CustomEvent('error', { detail: `${name}: ${res.Error}` }));
  }

  async micLevel() {
    if (this.mode !== 'live') return null;
    const res = await this.request({ GetMicLevel: this.serial });
    return typeof res?.MicLevel === 'number' ? res.MicLevel : null;
  }
}
