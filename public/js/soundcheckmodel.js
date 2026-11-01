// Lydtjek – what the report from soundcheck.rs means, as findings for the page. Pure; tested in
// tests/soundcheck.test.mjs.

export const DUCKING_TEXT = {
  0: 'slår Windows alle andre lyde fra',
  1: 'skruer Windows andre lyde ned med 80 %',
  2: 'skruer Windows andre lyde ned med 50 %',
  3: 'gør Windows ingenting',
};

const isGoXLR = (n) => /goxlr|tc-helicon/i.test(n || '');
const short = (n) => String(n || '').replace(/\s*\(.*\)\s*$/, '') || n;
const pct = (v) => `${Math.round(v * 100)} %`;
const fmtFormat = (f) => (f ? `${String(Math.round(f.rate / 100) / 10).replace('.', ',')} kHz · ${f.float ? '32 bit float' : `${f.bits} bit`}` : '');

/** Findings, worst first: { id, level: 'warn' | 'info' | 'ok', title, text, fix? }. */
export function soundcheckFindings(r, { engine = null } = {}) {
  const out = [];
  const eps = r?.endpoints || [];
  // ---- Windows lowers other sounds during calls ----
  const duck = r?.ducking ?? 1;
  if (duck !== 3) {
    out.push({ id: 'ducking', level: 'warn', title: 'Windows skruer ned for spil og musik under opkald',
      text: `Når Discord eller et andet opkald bruger mikrofonen, ${DUCKING_TEXT[duck] || DUCKING_TEXT[1]}. Det lyder, som om spillet pludselig bliver lavt.`,
      fix: { kind: 'ducking-off', label: 'Slå det fra' } });
  } else {
    out.push({ id: 'ducking', level: 'ok', title: 'Windows lader spil og musik være under opkald',
      text: 'Lydstyrken for spil og musik ændres ikke, når Discord bruger mikrofonen.',
      fix: r?.ducking_backup ? { kind: 'ducking-restore', label: 'Fortryd', quiet: true } : null });
  }
  // ---- GoXLR outputs and inputs in Windows ----
  const gox = eps.filter((e) => isGoXLR(e.name));
  let goxOk = gox.length > 0;
  for (const e of gox) {
    const name = short(e.name);
    const mic = e.flow === 'capture';
    if (e.muted) {
      goxOk = false;
      out.push({ id: `mute-${e.id}`, level: 'warn', title: `${name} er muted i Windows`,
        text: mic ? 'Discord og andre programmer hører dig ikke, uanset hvad GoXLR’en viser.' : 'Lyd, der sendes hertil, når ikke frem til GoXLR’en.',
        fix: { kind: 'unmute', id: e.id, label: 'Slå lyden til' } });
    } else if (Number.isFinite(e.volume) && e.volume < 0.98 && (!mic || /chat/i.test(e.name))) {
      goxOk = false;
      out.push({ id: `vol-${e.id}`, level: 'info', title: `Windows-lydstyrken for ${name} er ${pct(e.volume)}`,
        text: mic ? 'Windows skruer ned for mikrofonen, før Discord får den. Brug GoXLR’ens gain til niveauet, og sæt Windows til 100 %.'
          : 'GoXLR’ens fader styrer lydstyrken. Med 100 % her kommer hele signalet igennem, og faderen får hele sit spænd.',
        fix: { kind: 'volume100', id: e.id, label: 'Sæt til 100 %', confirm: !mic } });
    }
  }
  if (goxOk) out.push({ id: 'goxlr-levels', level: 'ok', title: 'GoXLR-enhederne står på 100 % i Windows', text: 'Ingen af dem er muted eller skruet ned i Windows.' });
  // ---- default devices ----
  const defOut = eps.find((e) => e.flow === 'render' && e.default);
  if (defOut && !isGoXLR(defOut.name) && gox.some((e) => e.flow === 'render')) {
    const sys = gox.find((e) => e.flow === 'render' && /system/i.test(e.name)) || gox.find((e) => e.flow === 'render');
    out.push({ id: 'default-out', level: 'info', title: `Windows’ standardudgang er ${short(defOut.name)}`,
      text: 'Spil og programmer uden egen indstilling spiller ikke gennem GoXLR’en – og får hverken GoXLR-mixet eller EQ’en fra GoXLR-udgangene.',
      fix: sys ? { kind: 'default', id: sys.id, label: `Brug ${short(sys.name)}` } : null });
  }
  if (defOut?.muted && !isGoXLR(defOut.name)) {
    out.push({ id: `mute-${defOut.id}`, level: 'warn', title: `${short(defOut.name)} er muted i Windows`, text: 'Det er Windows’ standardudgang.', fix: { kind: 'unmute', id: defOut.id, label: 'Slå lyden til' } });
  }
  const defIn = eps.find((e) => e.flow === 'capture' && e.default_comm);
  if (defIn && !isGoXLR(defIn.name) && gox.some((e) => e.flow === 'capture')) {
    const chat = gox.find((e) => e.flow === 'capture' && /chat/i.test(e.name));
    out.push({ id: 'default-in', level: 'info', title: `Mikrofonen til opkald er ${short(defIn.name)}`,
      text: 'Programmer, der bruger Windows’ standard, får ikke GoXLR’ens mikrofon med gate, kompressor og EQ.',
      fix: chat ? { kind: 'default-comm', id: chat.id, label: `Brug ${short(chat.name)}` } : null });
  }
  // ---- formats ----
  const formats = gox.filter((e) => e.flow === 'render' && e.format);
  const low = formats.filter((e) => !e.format.float && e.format.bits < 24);
  if (low.length) {
    out.push({ id: 'format-bits', level: 'info', title: `${low.map((e) => short(e.name)).join(', ')} kører med ${low[0].format.bits} bit`,
      text: '24 bit giver mere plads til de stille detaljer. Skift under Lydindstillinger → Flere lydindstillinger → udgangen → Egenskaber → Avanceret → Standardformat.' });
  } else if (formats.length) {
    out.push({ id: 'format', level: 'ok', title: `Lydformat: ${fmtFormat(formats[0].format)}`, text: formats.length > 1 ? 'Alle GoXLR-udgange kører med samme format.' : '' });
  }
  // ---- EQ engine ----
  if (engine) {
    if (engine.kind === 'none') out.push({ id: 'eq', level: 'info', title: 'EQ-motoren er ikke installeret', text: 'Afspilnings-EQ’en virker først, når motoren er sat på udgangene.', fix: { kind: 'page', page: 'outeq', label: 'Gå til Afspilnings-EQ' } });
    else if (engine.kind === 'external') out.push({ id: 'eq', level: 'info', title: 'EQ’en kører i en separat Equalizer APO', text: 'GoXLR Studio kan erstatte den med sin indbyggede motor, som tester sig selv og ikke kan ødelægges af Peace.', fix: { kind: 'page', page: 'outeq', label: 'Gå til Afspilnings-EQ' } });
    else if (engine.unregistered) out.push({ id: 'eq', level: 'warn', title: 'EQ-motoren skal repareres', text: 'Windows kan ikke starte motoren, så EQ’en høres ikke.', fix: { kind: 'page', page: 'outeq', label: 'Gå til Afspilnings-EQ' } });
    else if (engine.summary && !engine.summary.ok) out.push({ id: 'eq', level: 'warn', title: 'EQ’en rammer ikke al lyden', text: engine.summary.text, fix: { kind: 'page', page: 'outeq', label: 'Gå til Afspilnings-EQ' } });
    else if (engine.summary?.ok) out.push({ id: 'eq', level: 'ok', title: 'EQ-motoren kører', text: engine.summary.text });
  }
  const rank = { warn: 0, info: 1, ok: 2 };
  return out.sort((a, b) => rank[a.level] - rank[b.level]);
}
