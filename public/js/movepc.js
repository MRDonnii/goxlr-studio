// "Flyt til ny pc": everything in one file – GoXLR Studio's settings (hotkeys, scenes, pedals, app
// rules, EQ presets, theme …) plus the GoXLR profiles, mic profiles, presets, samples, icons and the
// sound bank. On the new pc: install GoXLR Studio, open the file, done. Passwords (MQTT/OBS) are only
// included when asked for. Old backup files (settings only) can be opened the same way.
import { h, toast, confirmDialog } from './ui.js';
import { isNative, storeGet, storeSet, moveCollect, moveRestore } from './native.js';
import { t } from './i18n.js';

export const BACKUP_KEYS = ['prefs', 'scenes', 'hotkeys', 'app-rules', 'app-triggers', 'device-triggers', 'output-eq', 'ducking', 'pedals'];
const SECRETS = [['mqtt', 'password'], ['obs', 'password']];
export const KIND_LABEL = {
  profiles: ['GoXLR-profil', 'GoXLR-profiler'],
  'mic-profiles': ['mikrofonprofil', 'mikrofonprofiler'],
  presets: ['effekt-preset', 'effekt-presets'],
  samples: ['sample', 'samples'],
  icons: ['ikon', 'ikoner'],
  sounds: ['lyd i lydbanken', 'lyde i lydbanken'],
};

/** The GoXLR engine's folders, as [kind, path] (the sound bank's folder the app knows itself). */
export function moveDirs(paths = {}) {
  return Object.entries({ profiles: paths.profile_directory, 'mic-profiles': paths.mic_profile_directory, presets: paths.presets_directory, samples: paths.samples_directory, icons: paths.icons_directory })
    .filter(([, v]) => v).map(([k, v]) => [k, String(v)]);
}

/** prefs without passwords (a copy). */
export function stripSecrets(prefs) {
  if (!prefs) return prefs;
  const out = structuredClone(prefs);
  for (const [a, b] of SECRETS) if (out[a] && b in out[a]) delete out[a][b];
  return out;
}

/** Imported prefs keep this pc's passwords when the file has none. */
export function keepSecrets(imported, current) {
  if (!imported) return imported;
  const out = structuredClone(imported);
  for (const [a, b] of SECRETS) if (current?.[a]?.[b] && !out[a]?.[b] && out[a]) out[a][b] = current[a][b];
  return out;
}

export function buildMoveFile({ data, files = [], skipped = [], version = null, secrets = false, created = new Date().toISOString() }) {
  const d = { ...data };
  if (!secrets && d.prefs) d.prefs = stripSecrets(d.prefs);
  return { app: 'goxlr-studio', kind: 'move', format: 1, version, created, secrets, data: d, files, skipped };
}

/** Checks a file (a move file or an older backup) → { data, files, created }; throws if it isn't one. */
export function readMoveFile(obj) {
  if (!obj || obj.app !== 'goxlr-studio' || typeof obj.data !== 'object' || !obj.data) throw new Error('Ikke en GoXLR Studio-fil');
  const files = Array.isArray(obj.files) ? obj.files.filter((f) => f && typeof f.kind === 'string' && typeof f.name === 'string' && typeof f.data === 'string') : [];
  const data = Object.fromEntries(Object.entries(obj.data).filter(([k]) => BACKUP_KEYS.includes(k)));
  return { data, files, created: obj.created || null, secrets: !!obj.secrets };
}

/** "3 GoXLR-profiler, 1 mikrofonprofil" – what the files are (tr translates the words). */
export function filesSummary(files, tr = (s) => s) {
  const n = {};
  for (const f of files) n[f.kind] = (n[f.kind] || 0) + 1;
  return Object.keys(KIND_LABEL).filter((k) => n[k]).map((k) => `${n[k]} ${tr(KIND_LABEL[k][n[k] === 1 ? 0 : 1])}`).join(', ');
}

const stamp = () => {
  const d = new Date();
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
};

export function moveCard(ctx) {
  const secrets = h('input', { type: 'checkbox', 'data-testid': 'move-secrets' });
  const status = h('div', { class: 'hint', 'data-testid': 'move-status' });
  const fileIn = h('input', { type: 'file', accept: '.json,application/json', style: { display: 'none' }, 'data-testid': 'move-file' });

  const exportAll = async (btn) => {
    btn.disabled = true;
    status.textContent = 'Samler filer…';
    try {
      const data = {};
      for (const k of BACKUP_KEYS) data[k] = await storeGet(k, null);
      const dirs = moveDirs(ctx.conn.status?.paths);
      const got = await moveCollect(dirs);
      const file = buildMoveFile({ data, files: got.files, skipped: got.skipped, version: ctx.updateState?.current || null, secrets: secrets.checked });
      const blob = new Blob([JSON.stringify(file)], { type: 'application/json' });
      const a = h('a', { href: URL.createObjectURL(blob), download: `GoXLR Studio - flyt til ny pc ${new Date().toISOString().slice(0, 10)}.json` });
      a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      const what = filesSummary(got.files, t);
      status.replaceChildren(
        h('div', {}, what ? `Gemt: indstillinger + ${what}.` : 'Gemt: indstillinger.'),
        !dirs.length ? h('div', {}, 'GoXLR’en er ikke forbundet, så dens profiler er ikke med.') : '',
        got.skipped.length ? h('div', {}, `For store til filen: ${got.skipped.join(', ')}.`) : '');
    } catch (e) { status.textContent = ''; toast(`Flyt til ny pc: ${e.message || e}`); }
    btn.disabled = false;
  };

  fileIn.addEventListener('change', async () => {
    const f = fileIn.files[0];
    fileIn.value = '';
    if (!f) return;
    try {
      const file = readMoveFile(JSON.parse(await f.text()));
      const what = filesSummary(file.files, t);
      const when = file.created ? new Date(file.created).toLocaleString('da-DK') : '?';
      if (!(await confirmDialog(`Hent alt fra filen (lavet ${when})?\n\n${what ? `Indstillinger + ${what}.` : 'Indstillinger.'}\n\nDine nuværende indstillinger overskrives. Profiler med samme navn, men andet indhold, gemmes i backup-mappen først.`, { ok: 'Hent alt' }))) return;
      const dirs = moveDirs(ctx.conn.status?.paths);
      const notes = [];
      if (file.files.length) {
        const r = await moveRestore(file.files, dirs, stamp());
        notes.push(r.same ? `Filer lagt på plads: ${r.written} (${r.same} var der i forvejen).` : `Filer lagt på plads: ${r.written}.`);
        if (r.skipped.length) notes.push(!dirs.length ? 'GoXLR’en er ikke forbundet – åbn filen igen, når den er, for at få profilerne med.' : `Sprunget over: ${r.skipped.length}.`);
      }
      for (const k of BACKUP_KEYS) {
        if (!(k in file.data)) continue;
        await storeSet(k, k === 'prefs' ? keepSecrets(file.data[k], ctx.prefs) : file.data[k]);
      }
      for (const n of notes) toast(n, 'info');
      toast('Alt er hentet – genindlæser…', 'info');
      setTimeout(() => location.reload(), 3000);
    } catch (e) { toast(`Flyt til ny pc: ${e.message || e}`); }
  });

  const exportBtn = h('button', { class: 'btn sm primary', 'data-testid': 'move-export' }, 'Gem alt i én fil');
  exportBtn.addEventListener('click', () => exportAll(exportBtn));
  return h('div', { class: 'card', 'data-testid': 'move-card' }, h('h2', {}, 'Backup og flyt til ny pc'),
    h('div', { class: 'hint', style: { marginBottom: '8px' } }, 'Én fil med det hele: genveje, scener, pedaler, app-regler, EQ-presets, tema og indstillinger – og GoXLR-profiler, mikrofonprofiler, samples og lydbanken. På den nye pc: installér GoXLR Studio, forbind GoXLR’en og åbn filen her.'),
    h('div', { class: 'row', style: { flexWrap: 'wrap' } }, exportBtn,
      h('button', { class: 'btn sm', 'data-testid': 'move-import', onclick: () => fileIn.click() }, 'Hent fra fil…'), fileIn),
    h('label', { class: 'check-inline', style: { marginTop: '8px' } }, secrets, h('span', {}, 'Tag adgangskoder med (MQTT og OBS)')),
    status,
    !isNative() ? h('div', { class: 'hint' }, 'Demo: filerne er eksempler.') : null,
    h('div', { class: 'hint', style: { marginTop: '6px' } }, 'Lydenheder hedder det samme på den nye pc, men har nye id’er – tjek "EQ gælder for" og hurtig-skift bagefter.'));
}
