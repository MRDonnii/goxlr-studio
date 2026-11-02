// REW (Room EQ Wizard) measurements: its own .mdat files (Java serialisation) and "Export
// measurement as text" files. Only what rumkorrektion needs is read: the frequency response
// (SPL per frequency), the name and whether a microphone calibration file was used. Pure, no DOM.

// ---------- Java object serialisation (java.io.ObjectInputStream's format) ----------
const TC = { NULL: 0x70, REFERENCE: 0x71, CLASSDESC: 0x72, OBJECT: 0x73, STRING: 0x74, ARRAY: 0x75, CLASS: 0x76, BLOCKDATA: 0x77, ENDBLOCKDATA: 0x78, RESET: 0x79, BLOCKDATALONG: 0x7a, EXCEPTION: 0x7b, LONGSTRING: 0x7c, PROXYCLASSDESC: 0x7d, ENUM: 0x7e };
const SC_WRITE_METHOD = 0x01, SC_SERIALIZABLE = 0x02, SC_EXTERNALIZABLE = 0x04, SC_BLOCK_DATA = 0x08;
const BASE_HANDLE = 0x7e0000;

/** Reads every top-level item of a Java serialisation stream. Objects are { cls, fields, ann }. */
export function readJavaStream(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 0;
  let handles = [];
  const need = (n) => { if (pos + n > bytes.length) throw new Error('Filen slutter for tidligt'); };
  const u8 = () => { need(1); return bytes[pos++]; };
  const u16 = () => { need(2); const v = dv.getUint16(pos); pos += 2; return v; };
  const i32 = () => { need(4); const v = dv.getInt32(pos); pos += 4; return v; };
  const i64 = () => { need(8); const v = dv.getBigInt64(pos); pos += 8; return v; };
  const utf8 = new TextDecoder('utf-8');
  const utf = (len) => { need(len); const s = utf8.decode(bytes.subarray(pos, pos + len)); pos += len; return s; };
  const newHandle = (v) => { handles.push(v); return handles.length - 1; };
  if (u16() !== 0xaced) throw new Error('Ikke en REW-fil (.mdat)');
  u16(); // version

  const prim = {
    B: () => dv.getInt8(pos++), Z: () => u8() !== 0, C: () => u16(), S: () => { const v = dv.getInt16(pos); pos += 2; return v; },
    I: i32, J: () => Number(i64()), F: () => { need(4); const v = dv.getFloat32(pos); pos += 4; return v; },
    D: () => { need(8); const v = dv.getFloat64(pos); pos += 8; return v; },
  };

  function classDesc() {
    const tc = u8();
    if (tc === TC.NULL) return null;
    if (tc === TC.REFERENCE) return handles[i32() - BASE_HANDLE];
    if (tc === TC.CLASSDESC) {
      const name = utf(u16());
      i64(); // serialVersionUID
      const desc = { name, flags: 0, fields: [], parent: null };
      newHandle(desc);
      desc.flags = u8();
      const n = u16();
      for (let i = 0; i < n; i++) {
        const type = String.fromCharCode(u8());
        const fname = utf(u16());
        if (type === 'L' || type === '[') content(); // the field's class name (a string)
        desc.fields.push({ type, name: fname });
      }
      annotation();
      desc.parent = classDesc();
      return desc;
    }
    if (tc === TC.PROXYCLASSDESC) {
      const desc = { name: 'proxy', flags: SC_SERIALIZABLE, fields: [], parent: null };
      newHandle(desc);
      const n = i32();
      for (let i = 0; i < n; i++) utf(u16());
      annotation();
      desc.parent = classDesc();
      return desc;
    }
    throw new Error(`Uventet byte 0x${tc.toString(16)} i klassebeskrivelse`);
  }

  // Items up to TC_ENDBLOCKDATA (a class's writeObject data).
  function annotation() {
    const out = [];
    for (;;) {
      if (bytes[pos] === TC.ENDBLOCKDATA) { pos++; return out; }
      out.push(content());
    }
  }

  function readObject() {
    const desc = classDesc();
    const obj = { cls: desc?.name || '', fields: {}, ann: [] };
    newHandle(obj);
    const chain = [];
    for (let d = desc; d; d = d.parent) chain.unshift(d);
    for (const d of chain) {
      if (d.flags & SC_EXTERNALIZABLE) {
        if (d.flags & SC_BLOCK_DATA) obj.ann.push(...annotation());
        else throw new Error(`Kan ikke læse ${d.name}`);
        continue;
      }
      for (const f of d.fields) obj.fields[f.name] = prim[f.type] ? prim[f.type]() : content();
      if (d.flags & SC_WRITE_METHOD) obj.ann.push(...annotation());
    }
    return obj;
  }

  function readArray() {
    const desc = classDesc();
    const arr = { cls: desc.name, values: null };
    newHandle(arr);
    const n = i32();
    const t = desc.name[1];
    if (t === 'F' || t === 'D') {
      const size = t === 'F' ? 4 : 8;
      need(n * size);
      const out = new Float64Array(n);
      for (let i = 0; i < n; i++) out[i] = t === 'F' ? dv.getFloat32(pos + i * 4) : dv.getFloat64(pos + i * 8);
      pos += n * size;
      arr.values = out;
    } else if (prim[t]) {
      if (t === 'B') { need(n); arr.values = bytes.slice(pos, pos + n); pos += n; } else { arr.values = []; for (let i = 0; i < n; i++) arr.values.push(prim[t]()); }
    } else {
      arr.values = [];
      for (let i = 0; i < n; i++) arr.values.push(content());
    }
    return arr;
  }

  function content() {
    const tc = u8();
    switch (tc) {
      case TC.NULL: return null;
      case TC.REFERENCE: return handles[i32() - BASE_HANDLE];
      case TC.STRING: { const s = utf(u16()); newHandle(s); return s; }
      case TC.LONGSTRING: { const s = utf(Number(i64())); newHandle(s); return s; }
      case TC.OBJECT: return readObject();
      case TC.ARRAY: return readArray();
      case TC.ENUM: { const d = classDesc(); const e = { cls: d?.name, enum: null }; newHandle(e); e.enum = content(); return e; }
      case TC.CLASS: { const d = classDesc(); newHandle(d); return d; }
      case TC.CLASSDESC: case TC.PROXYCLASSDESC: pos--; return classDesc();
      case TC.BLOCKDATA: { const n = u8(); need(n); const b = bytes.slice(pos, pos + n); pos += n; return { block: b }; }
      case TC.BLOCKDATALONG: { const n = i32(); need(n); const b = bytes.slice(pos, pos + n); pos += n; return { block: b }; }
      case TC.RESET: handles = []; return content();
      default: throw new Error(`Uventet byte 0x${tc.toString(16)} ved position ${pos - 1}`);
    }
  }

  const items = [];
  while (pos < bytes.length) items.push(content());
  return items;
}

const num = (v) => (v && typeof v === 'object' && 'fields' in v ? Number(v.fields.value) : Number(v));

/** Frequencies of a REW measurement: linear (startFreq + i·freqStep) or log-spaced. */
function measFreqs(f, n) {
  const start = num(f.startFreq);
  if (f.isLogSpaced) {
    const step = num(f.logStep) || 2 ** (1 / (num(f.ppo) || 48));
    return Array.from({ length: n }, (_, i) => start * step ** i);
  }
  const step = num(f.freqStep);
  return Array.from({ length: n }, (_, i) => start + i * step);
}

/**
 * The measurements in a REW .mdat file: [{ name, date, freqs, spl, calibrated, output, sampleRate }].
 * Dates come from REW's own list of the measurements (the html captions), in the same order.
 */
export function readRewMdat(buffer) {
  const items = readJavaStream(buffer);
  if (items[0] !== 'REW Measurement Data File V2' && !String(items[0] || '').startsWith('REW')) throw new Error('Ikke en REW-målefil');
  const captions = items.filter((x) => typeof x === 'string' && x.startsWith('<HTML>'))
    .map((s) => s.replace(/<style[^>]*>.*?<\/style>/i, '').replace(/<BR>/gi, ' ').replace(/<[^>]+>/g, '').trim());
  const out = [];
  for (const m of items.filter((x) => x?.cls === 'roomeqwizard.MeasData')) {
    const f = m.fields;
    const spl = f.splValues?.values;
    if (!spl?.length) continue;
    const cal = f.meterCal?.fields || {};
    const i = out.length;
    out.push({
      name: String(f.shortDesc || '').trim() || `Måling ${i + 1}`,
      date: (captions[i] || '').split(' ').slice(0, 2).join(' '),
      freqs: measFreqs(f, spl.length),
      spl: Array.from(spl),
      calibrated: !!String(cal.sourceName || cal.sourcePath || '').trim(),
      // Timing: with a timing reference (loopback/acoustic) the impulse's peak is the sound's arrival time.
      timing: (() => {
        const ir = f.irData?.fields || {};
        const usedRef = num(ir.usedTimingRef) === 1 || ir.usedTimingRef?.fields?.value === true || ir.usedTimingRef === true;
        const peak = num(ir.origPeakTime);
        return Number.isFinite(peak) ? { usedRef, peak } : null;
      })(),
      output: String(f.outputName || ''),
      sampleRate: num(f.sampleRate) || 0,
    });
  }
  if (!out.length) throw new Error('Fandt ingen målinger i filen');
  // REW gives every sweep of a series the same name – the time tells them apart.
  const dup = new Set(out.map((m) => m.name).filter((n, i, all) => all.indexOf(n) !== i));
  for (const m of out) if (dup.has(m.name) && m.date) m.name = `${m.name} · ${m.date.split(' ').pop()}`;
  return out;
}

/** REW's "Export measurement as text" (and similar two/three-column files): freq, SPL[, phase]. */
export function readRewText(text, name = 'Måling') {
  const freqs = [];
  const spl = [];
  let calibrated = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^[*#;]/.test(line) || /^[a-z]/i.test(line)) {
      if (/cal(ibration)? ?(file|data)?:/i.test(line)) calibrated = !/none|not used/i.test(line);
      continue;
    }
    const parts = line.split(/[\s;\t]+/).map((p) => Number(p.replace(',', '.')));
    if (parts.length < 2 || !parts.slice(0, 2).every(Number.isFinite) || parts[0] <= 0) continue;
    freqs.push(parts[0]);
    spl.push(parts[1]);
  }
  if (freqs.length < 10) throw new Error('Fandt ingen frekvensgang i filen (frekvens og dB pr. linje)');
  return [{ name, date: '', freqs, spl, calibrated, output: '', sampleRate: 0 }];
}

/** Either kind of file, from its bytes. */
export function readMeasurementFile(buffer, fileName = '') {
  const b = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (b[0] === 0xac && b[1] === 0xed) return readRewMdat(b);
  return readRewText(new TextDecoder('utf-8').decode(b), fileName.replace(/\.[^.]+$/, '') || 'Måling');
}

/**
 * A microphone calibration file (miniDSP UMIK-1/UMIK-2, Dayton …): lines "freq dB [phase]", an
 * optional header like `"Sens Factor =-1.378dB, SERNO: …"`. Returns { freqs, db } (the mic's own
 * deviation – subtracted from a measurement made without it).
 */
export function readCalFile(text) {
  const freqs = [];
  const db = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^["*#;a-z]/i.test(line)) continue;
    const p = line.split(/[\s;,\t]+/).map(Number);
    if (p.length < 2 || !Number.isFinite(p[0]) || !Number.isFinite(p[1]) || p[0] <= 0) continue;
    if (freqs.length && p[0] <= freqs[freqs.length - 1]) continue;
    freqs.push(p[0]);
    db.push(p[1]);
  }
  if (freqs.length < 10) throw new Error('Det ligner ikke en kalibreringsfil (frekvens og dB pr. linje)');
  return { freqs, db };
}
