// Settings for one key/dial (and the connection to GoXLR Studio, shared by all keys).
/* global GXS */
let ws = null;
let uuid = '';
let actionCtx = '';
let settings = {};
let globals = {};
let lang = 'en';
const kind = document.body.dataset.kind;
const $ = (id) => document.getElementById(id);
const S = {
  da: {
    action: 'Handling', conn: 'Forbindelse til GoXLR Studio', token: 'Token', port: 'Port',
    hconn: 'Slå "Lokalt API" til i GoXLR Studio (Indstillinger), tryk "Kopiér token" og sæt den ind her. Porten står samme sted.',
    ok: 'Forbundet til GoXLR Studio', bad: 'Ikke forbundet – er GoXLR Studio startet, og er det lokale API slået til?', badToken: 'Forkert token – kopiér den igen i GoXLR Studio', noToken: 'Indsæt token fra GoXLR Studio (se nederst)',
    pick: '— vælg —', channel: 'Kanal', name: 'Navn', step: 'Trin (%)', direction: 'Tryk på tast', up: 'Skru op', down: 'Skru ned',
  },
  en: {
    action: 'Action', conn: 'Connection to GoXLR Studio', token: 'Token', port: 'Port',
    hconn: 'Switch on "Local API" in GoXLR Studio (Settings), press "Copy token" and paste it here. The port is shown there too.',
    ok: 'Connected to GoXLR Studio', bad: 'Not connected – is GoXLR Studio running, with the local API switched on?', badToken: 'Wrong token – copy it again in GoXLR Studio', noToken: 'Paste the token from GoXLR Studio (see below)',
    pick: '— pick —', channel: 'Channel', name: 'Name', step: 'Step (%)', direction: 'Key press', up: 'Volume up', down: 'Volume down',
  },
};
const s = (k) => (S[lang] || S.en)[k];
const CHANNELS = ['Mic', 'Chat', 'Music', 'Game', 'System', 'Console', 'LineIn', 'Sample', 'Headphones', 'LineOut'];

// eslint-disable-next-line no-unused-vars
function connectElgatoStreamDeckSocket(port, inUUID, registerEvent, info, actionInfo) {
  uuid = inUUID;
  try { lang = GXS.lang(JSON.parse(info)); } catch { /* default */ }
  try { const a = JSON.parse(actionInfo); actionCtx = a.context; settings = a.payload?.settings || {}; } catch { /* none */ }
  texts();
  ws = new WebSocket(`ws://127.0.0.1:${port}`);
  ws.onopen = () => {
    ws.send(JSON.stringify({ event: registerEvent, uuid }));
    ws.send(JSON.stringify({ event: 'getGlobalSettings', context: uuid }));
  };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.event === 'didReceiveGlobalSettings') { globals = m.payload?.settings || {}; fill(); check(); }
  };
}

function texts() {
  for (const [id, key] of [['l-action', 'action'], ['l-conn', 'conn'], ['l-token', 'token'], ['l-port', 'port'], ['h-conn', 'hconn'], ['l-channel', 'channel'], ['l-name', 'name'], ['l-step', 'step'], ['l-direction', 'direction']]) if ($(id)) $(id).textContent = s(key);
  if ($('direction')) { $('direction').options[0].textContent = s('up'); $('direction').options[1].textContent = s('down'); }
}

const saveSettings = () => ws.send(JSON.stringify({ event: 'setSettings', context: uuid, payload: settings }));
const saveGlobals = () => {
  ws.send(JSON.stringify({ event: 'setGlobalSettings', context: uuid, payload: globals }));
  ws.send(JSON.stringify({ event: 'sendToPlugin', action: kind === 'volume' ? 'com.goxlrstudio.volume' : 'com.goxlrstudio.action', context: uuid, payload: { reload: true } }));
};

function fill() {
  $('token').value = globals.token || '';
  $('port').value = globals.port || GXS.DEFAULT_PORT;
  if (!globals.token) $('conn').open = true;
  if (kind === 'volume') {
    $('channel').replaceChildren(...CHANNELS.map((c) => new Option(c, c, false, (settings.channel || 'Music') === c)));
    $('name').value = settings.name || '';
    $('step').value = settings.step || '';
    $('step').placeholder = '10 / 2';
    $('direction').value = settings.direction || 'up';
  }
}

async function check() {
  const st = $('status');
  if (!globals.token) { st.textContent = s('noToken'); st.className = 'status bad'; return; }
  try {
    const actions = await GXS.get(globals, '/actions');
    st.textContent = s('ok'); st.className = 'status ok';
    if (kind === 'action') {
      const sel = $('action');
      const groups = new Map();
      for (const a of actions) { if (!groups.has(a.group)) groups.set(a.group, []); groups.get(a.group).push(a); }
      sel.replaceChildren(new Option(s('pick'), ''), ...[...groups].map(([g, items]) => {
        const og = document.createElement('optgroup'); og.label = g;
        og.append(...items.map((a) => new Option(a.label, a.id, false, a.id === settings.action)));
        return og;
      }));
      // A saved action that the app no longer lists (e.g. a deleted profile) stays visible.
      if (settings.action && !actions.some((a) => a.id === settings.action)) sel.append(new Option(settings.label || settings.action, settings.action, true, true));
    }
  } catch (e) {
    st.textContent = String(e.message) === 'token' ? s('badToken') : s('bad'); st.className = 'status bad';
  }
}

$('token').addEventListener('change', () => { globals.token = $('token').value.trim(); saveGlobals(); check(); });
$('port').addEventListener('change', () => { globals.port = Number($('port').value) || GXS.DEFAULT_PORT; saveGlobals(); check(); });
if (kind === 'action') {
  $('action').addEventListener('change', () => {
    const o = $('action').selectedOptions[0];
    settings.action = $('action').value;
    settings.label = o ? o.textContent : '';
    saveSettings();
  });
} else {
  for (const id of ['channel', 'name', 'step', 'direction']) {
    $(id).addEventListener('change', () => { settings[id] = id === 'step' ? Number($(id).value) || undefined : $(id).value; saveSettings(); });
  }
}
