import { h, toast, slider, confirmDialog, promptDialog, logActivity } from './ui.js';
import { isNative, soundsList, soundsSave, soundsDelete, soundsRename, soundsOpenDir } from './native.js';
import { playSound, stopSounds, forgetSound } from './soundboard.js';
import { prettyAccel } from './views-hotkeys.js';

const KEY_POOL = Array.from({ length: 12 }, (_, i) => `Ctrl+Alt+Shift+F${i + 1}`)
  .concat(['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'].map((d) => `Ctrl+Alt+Shift+${d}`));

const readBase64 = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',')[1] || '');
  r.onerror = () => reject(r.error);
  r.readAsDataURL(file);
});

// Lydbank: sound pads that play on the GoXLR's "Sample" channel – with the GoXLR's routing they
// reach Discord and the stream. Also works on a GoXLR Mini (no hardware sampler).
export function soundsView(ctx) {
  const { conn, binder } = ctx;
  const p = ctx.prefs;
  p.soundboard ??= { volume: 80, overlap: true };
  const sb = p.soundboard;
  let sounds = [];
  const pads = h('div', { class: 'sound-pads', 'data-testid': 'sound-pads' });

  const reload = async () => { sounds = await soundsList().catch(() => []); render(); ctx.onSoundsChanged?.(); };
  const keyOf = (file) => ctx.hotkeys.find((b) => b.action === `sound:${file}` && b.accel)?.accel;
  const giveKey = async (s) => {
    const accel = KEY_POOL.find((k) => !ctx.hotkeys.some((b) => b.accel === k));
    if (!accel) { toast('Alle ledige taster er brugt – giv lyden en tast under Genveje'); return; }
    ctx.hotkeys.push({ id: crypto.randomUUID(), accel, action: `sound:${s.file}` });
    await ctx.saveHotkeys();
    toast(`${s.name}: ${prettyAccel(accel)}`, 'info');
    render();
  };
  const rename = async (s) => {
    const n = await promptDialog('Nyt navn på lyden', s.name);
    if (!n || n === s.name) return;
    try {
      const file = await soundsRename(s.file, n);
      forgetSound(s.file);
      // Keep its hotkeys.
      for (const b of ctx.hotkeys) if (b.action === `sound:${s.file}`) b.action = `sound:${file}`;
      await ctx.saveHotkeys();
      reload();
    } catch (e) { toast(String(e.message || e)); }
  };
  const remove = async (s) => {
    if (!(await confirmDialog(`Slet lyden "${s.name}" fra lydbanken?`, { ok: 'Slet', danger: true }))) return;
    try {
      await soundsDelete(s.file);
      forgetSound(s.file);
      ctx.hotkeys = ctx.hotkeys.filter((b) => b.action !== `sound:${s.file}`);
      await ctx.saveHotkeys();
      reload();
    } catch (e) { toast(String(e.message || e)); }
  };
  const play = (s) => playSound(ctx, s.file).catch((e) => toast(`Kunne ikke afspille ${s.name}: ${e.message || e}`));

  const render = () => {
    pads.replaceChildren(...sounds.map((s) => {
      const key = keyOf(s.file);
      return h('div', { class: 'sound-pad', 'data-testid': 'sound-pad' },
        h('button', { class: 'sound-play', title: 'Afspil', onclick: () => play(s) }, h('span', { class: 'sound-name' }, s.name), key ? h('span', { class: 'sound-key' }, prettyAccel(key)) : null),
        h('div', { class: 'sound-tools' },
          key ? null : h('button', { class: 'btn sm', title: 'Giv lyden en genvejstast (også til Stream Deck)', onclick: () => giveKey(s) }, 'Tast'),
          h('button', { class: 'btn sm', onclick: () => rename(s) }, 'Omdøb'),
          h('button', { class: 'btn sm', title: 'Slet', onclick: () => remove(s) }, '✕')));
    }));
    if (!sounds.length) pads.append(h('div', { class: 'hint' }, 'Ingen lyde endnu. Tilføj mp3-, wav- eller ogg-filer – fx et airhorn, en applaus eller en "ba dum tss".'));
  };

  const fileIn = h('input', { type: 'file', accept: 'audio/*,.mp3,.wav,.ogg,.opus,.flac,.m4a,.aac', multiple: true, style: { display: 'none' }, 'data-testid': 'sound-file', onchange: async () => {
    const files = [...fileIn.files];
    fileIn.value = '';
    let n = 0;
    for (const f of files) {
      if (f.size > 20 * 1024 * 1024) { toast(`${f.name} er større end 20 MB`); continue; }
      try { await soundsSave(f.name, await readBase64(f)); n++; } catch (e) { toast(`${f.name}: ${e.message || e}`); }
    }
    const what = `${n} ${n === 1 ? 'lyd' : 'lyde'}`;
    if (n) { logActivity(`Lydbank: ${what} tilføjet`); toast(`${what} tilføjet`, 'info'); }
    reload();
  } });

  // The Sample channel's routing: where the sounds go.
  const route = (out, label) => {
    const cb = h('input', { type: 'checkbox', onchange: () => conn.mixer && conn.command('SetRouter', 'Samples', out, cb.checked) });
    binder.add(() => { cb.checked = !!conn.mixer?.router?.Samples?.[out]; cb.disabled = !conn.mixer; });
    return h('label', { class: 'engine-dev', 'data-testid': `sound-route-${out}` }, cb, h('span', {}, label));
  };

  reload();
  return h('div', { class: 'grid' },
    h('div', { class: 'card' },
      h('h2', {}, 'Lydbank', h('span', { class: 'row' },
        h('button', { class: 'btn sm primary', 'data-testid': 'sound-add', onclick: () => fileIn.click() }, '+ Tilføj lyde …'),
        h('button', { class: 'btn sm', 'data-testid': 'sound-stop', onclick: stopSounds }, 'Stop alle'))),
      fileIn, pads,
      h('div', { class: 'hint', style: { marginTop: '8px' } }, 'Lydene spilles på GoXLR’ens Sample-kanal. Giv dem en tast, så kan de også ligge på din Stream Deck (Stream Deck-siden) eller G-taster.')),
    h('div', { class: 'grid cols-2' },
      h('div', { class: 'card' }, h('h2', {}, 'Hvor lyden går hen'),
        route('ChatMic', 'Discord og andre opkald (Chat Mic)'),
        route('BroadcastMix', 'Stream og optagelse (Broadcast Mix)'),
        route('Headphones', 'Dine hovedtelefoner'),
        h('div', { class: 'hint', style: { marginTop: '6px' } }, 'Det er GoXLR’ens routing for Sample-kanalen – den samme som under Routing.')),
      h('div', { class: 'card' }, h('h2', {}, 'Afspilning'),
        slider(binder, { label: 'Lydstyrke', min: 0, max: 100, get: () => sb.volume ?? 80, set: (v) => { sb.volume = v; ctx.savePrefs(); }, fmt: (v) => `${v} %` }),
        slider(binder, { label: 'Sample-kanal', min: 0, max: 255, get: () => conn.mixer?.levels?.volumes?.Sample ?? 0, set: (v) => conn.command('SetVolume', 'Sample', v), fmt: (v) => `${Math.round((v / 255) * 100)} %` }),
        h('label', { class: 'engine-dev' }, h('input', { type: 'checkbox', checked: sb.overlap !== false, onchange: (e) => { sb.overlap = e.target.checked; ctx.savePrefs(); } }), h('span', {}, 'Flere lyde på én gang')),
        isNative() ? h('button', { class: 'btn sm', style: { marginTop: '8px' }, onclick: () => soundsOpenDir().catch((e) => toast(String(e))) }, 'Åbn mappen med lyde') : null)));
}
