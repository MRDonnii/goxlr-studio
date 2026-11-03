// Fejlfinder: turns what the app knows (the GoXLR engine's status and start history, its own log
// goxlr-daemon.log, the TC-Helicon driver) into findings with a solution. Pure, no DOM – the
// banner (app.js) and the Diagnose page show the findings, their `fixes` are actions app.js runs.

const LEVELS = { error: 0, warn: 1, info: 2 };

// Fix actions (handled by app.js `runFix`).
const START = { label: 'Start GoXLR-motoren', action: 'start-engine' };
const TAKEOVER = { label: 'Skift til GoXLR Studios motor', action: 'takeover' };
const LOG = { label: 'Åbn motorens log', action: 'open-log' };
const DIAG = { label: 'Se fejlfinding', action: 'goto:diag' };
const DRIVER = [{ label: 'Hent driver til GoXLR Mini', action: 'driver-mini' }, { label: 'Hent driver til GoXLR', action: 'driver-full' }];

/** What each known problem means and what to do about it. */
export const PROBLEMS = {
  'driver-missing': { level: 'error', title: 'TC-Helicons GoXLR-driver mangler',
    text: 'Uden driveren kan Windows og GoXLR Studio ikke tale med GoXLR’en. Installér driveren fra TC-Helicon og start GoXLR Studio igen.', fixes: DRIVER },
  'utility-running': { level: 'warn', title: 'GoXLR Utility kører og styrer GoXLR’en',
    text: 'Kun én GoXLR-motor kan styre GoXLR’en ad gangen. Lad GoXLR Studio overtage – GoXLR Utility stoppes og startes ikke længere med Windows.', fixes: [TAKEOVER] },
  'old-instance': { level: 'warn', title: 'En anden GoXLR-motor svarer allerede',
    text: 'Det sker typisk lige efter en opdatering, hvor den gamle udgave af GoXLR Studio stadig er ved at lukke. Appen prøver selv igen. Hjælper det ikke: luk GoXLR Studio helt (bakke-ikonet → Afslut), start den igen – eller genstart pc’en.', fixes: [START] },
  'port-busy': { level: 'error', title: 'Port 14564 er optaget',
    text: 'GoXLR-motoren bruger port 14564 til appen. Et andet program (typisk en gammel goxlr-daemon.exe) har den. Luk det i Jobliste, eller genstart pc’en.', fixes: [START, LOG] },
  'tc-app': { level: 'error', title: 'TC-Helicons GoXLR-app kører',
    text: 'TC-Helicons egen app og GoXLR Studio kan ikke styre GoXLR’en samtidig. Luk den (også i bakken ved uret), og start GoXLR-motoren igen.', fixes: [START] },
  pipe: { level: 'error', title: 'GoXLR-motorens interne forbindelse svarer ikke',
    text: 'Motorens named pipe er i stykker – det løser en genstart af pc’en.', fixes: [START] },
  'log-dir': { level: 'error', title: 'GoXLR-motoren kan ikke skrive sin log',
    text: 'Mappen GoXLR-on-Linux under %APPDATA% kan ikke skrives (fx flyttet til OneDrive eller ejet af en anden bruger). Giv din bruger adgang til mappen, og start motoren igen.', fixes: [START, LOG] },
  admin: { level: 'error', title: 'GoXLR Studio kører som administrator',
    text: 'GoXLR-motoren starter ikke med administrator-rettigheder. Luk GoXLR Studio og start den normalt (ikke “Kør som administrator”).', fixes: [] },
  crash: { level: 'error', title: 'GoXLR-motoren gik ned',
    text: 'Motoren stoppede med en programfejl. Start den igen – sker det igen, så gem Diagnose-rapporten (med motorens log) og send den til udvikleren.', fixes: [START, LOG] },
  'engine-error': { level: 'error', title: 'GoXLR-motoren stoppede med en fejl',
    text: 'Se fejlteksten nedenfor og motorens log. Start den igen – hjælper det ikke, så genstart pc’en.', fixes: [START, LOG] },
  'engine-stopped': { level: 'warn', title: 'GoXLR-motoren kører ikke',
    text: 'Den startes normalt automatisk, når appen starter. Start den her.', fixes: [START] },
  'autostart-off': { level: 'warn', title: 'GoXLR-motoren kører ikke',
    text: 'Automatisk start af GoXLR-motoren er slået fra under Indstillinger. Start den her, eller slå automatisk start til igen.', fixes: [START] },
  'no-device': { level: 'warn', title: 'GoXLR-motoren kører, men finder ingen GoXLR',
    text: 'Tjek at GoXLR’en har strøm (den store GoXLR har egen strømforsyning), at USB-kablet sidder i, og prøv en USB-port direkte på pc’en – ikke en hub eller et forlængerkabel. Sluk og tænd GoXLR’en.', fixes: [LOG] },
  'usb-open': { level: 'warn', title: 'Windows kunne ikke åbne GoXLR’en',
    text: 'GoXLR’en er måske i brug af et andet program (TC-Helicons app), eller USB-forbindelsen er ustabil. Luk andre GoXLR-programmer, prøv en anden USB-port, og sluk/tænd GoXLR’en.', fixes: [START, LOG] },
  'usb-unstable': { level: 'warn', title: 'GoXLR’en holdt op med at svare',
    text: 'USB-forbindelsen faldt ud. Typiske årsager: USB-hub, forlængerkabel, front-porte eller Windows’ USB-strømsparing. Brug en port direkte på bundkortet, og slå “USB selektiv suspendering” fra under Windows’ strømindstillinger.', fixes: [LOG] },
  'driver-version': { level: 'warn', title: 'Driverversionen passer ikke til GoXLR-motoren',
    text: 'GoXLR-motoren er lavet til TC-Helicons driver 5.12, 5.57 eller 5.68. Installér den nyeste driver fra TC-Helicon, så undgår du ustabilitet.', fixes: DRIVER },
  'profile-load': { level: 'info', title: 'En GoXLR-profil kunne ikke indlæses',
    text: 'GoXLR-motoren brugte en backup eller standardprofilen i stedet. Tjek dine profiler på Profiler-siden – historikken kan gendanne en ældre udgave.', fixes: [{ label: 'Gå til Profiler', action: 'goto:profiles' }] },
  paths: { level: 'warn', title: 'GoXLR-motoren kan ikke bruge sine mapper',
    text: 'Profil-, sample- eller ikon-mappen kunne ikke oprettes eller åbnes (fx flyttet til OneDrive eller uden skriveadgang).', fixes: [LOG] },
  'sampler-audio': { level: 'info', title: 'GoXLR’ens lydenheder blev ikke fundet',
    text: 'Motoren fandt ikke GoXLR’ens udgange i Windows (fx “Sample”). Tjek at de ikke er slået fra under Windows’ lydindstillinger – Lydtjek viser dem.', fixes: [{ label: 'Gå til Lydtjek', action: 'goto:soundcheck' }] },
};

// Lines of goxlr-daemon.log (English, from GoXLR Utility's code) → a problem.
export const LOG_PATTERNS = [
  [/panicked at/i, 'crash'],
  [/driver not found|goxlr driver was not found/i, 'driver-missing'],
  [/official goxlr application/i, 'tc-app'],
  [/goxlr daemon is already running/i, 'old-instance'],
  [/goxlr utility is already running|daemon process already running/i, 'utility-running'],
  [/unable to start http server|os error 10048|address (already )?in use/i, 'port-busy'],
  [/named pipe error/i, 'pipe'],
  [/unable to create log directory/i, 'log-dir'],
  [/api version mismatch/i, 'driver-version'],
  [/unable to open device/i, 'usb-open'],
  [/possible dead goxlr|device removed before update|invalid response received from the goxlr|error received from \S+/i, 'usb-unstable'],
  [/failed to load (mic )?profile/i, 'profile-load'],
  [/unable to create path|error opening path|unable to extract default/i, 'paths'],
  [/audio device not found|sampler not ready/i, 'sampler-audio'],
];

// The friendly (Danish) error texts of daemon_host.rs and the engine's own (English) ones.
const ERROR_PATTERNS = [
  [/goxlr-driver blev ikke fundet|driver was not found/i, 'driver-missing'],
  [/tc-helicons goxlr-app kører|official goxlr application/i, 'tc-app'],
  [/anden goxlr-motor svarer|goxlr daemon is already running/i, 'old-instance'],
  [/goxlr utility kører|goxlr utility is already running/i, 'utility-running'],
  [/port 14564|http server/i, 'port-busy'],
  [/named pipe/i, 'pipe'],
  [/log-mappe|log directory/i, 'log-dir'],
  [/administrator|run as root/i, 'admin'],
  [/panicked/i, 'crash'],
];

// Problems that stop the engine (they explain "kører ikke" better than the general findings).
const STOP_CAUSES = ['driver-missing', 'utility-running', 'old-instance', 'port-busy', 'tc-app', 'pipe', 'log-dir', 'admin', 'crash'];

/** The problem an error text is about (`engine-error` if unknown). */
export function classifyError(text) {
  const t = String(text || '');
  for (const [re, id] of ERROR_PATTERNS) if (re.test(t)) return id;
  return 'engine-error';
}

/** goxlr-daemon.log's lines since the engine last started (older runs are history). */
export function sessionLines(lines) {
  const all = lines || [];
  let start = -1;
  all.forEach((l, i) => { if (/Starting GoXLR Daemon/i.test(l)) start = i; });
  return start >= 0 ? all.slice(start) : all;
}

/** The level of a log line: 'error', 'warn' or null. */
export function lineLevel(line) {
  if (/\[\s*ERROR\s*\]|\bERROR\b|panicked at/.test(line)) return 'error';
  if (/\[\s*WARN\s*\]|\bWARN\b/.test(line)) return 'warn';
  return null;
}

/** Known problems in the log lines: [{ id, lines }] (newest line last, at most 3 per problem). */
export function logProblems(lines) {
  const found = new Map();
  for (const line of lines || []) {
    for (const [re, id] of LOG_PATTERNS) {
      if (!re.test(line)) continue;
      const f = found.get(id) || { id, lines: [] };
      f.lines.push(line);
      if (f.lines.length > 3) f.lines.shift();
      found.set(id, f);
      break;
    }
  }
  return [...found.values()];
}

/** A user's name in Windows paths is replaced (for reports that are sent on). */
export function scrubLine(line) {
  return String(line).replace(/([A-Za-z]:\\Users\\)[^\\/\s"']+/gi, '$1<bruger>').replace(/(\/home\/|\/Users\/)[^/\s"']+/g, '$1<bruger>');
}

/**
 * Findings, most serious first: [{ id, level, title, text, fixes, details }].
 * input = { native, mode ('live'|'demo'|'connecting'), autoStart, daemon (daemon_info),
 *           driver (driver_info), log (lines of goxlr-daemon.log) }
 */
export function troubleshoot(input = {}) {
  if (!input.native) return [];
  const out = new Map();
  const add = (id, details = []) => {
    const p = PROBLEMS[id];
    if (!p) return;
    const f = out.get(id) || { id, ...p, details: [] };
    for (const d of details) if (d && !f.details.includes(d)) f.details.push(d);
    out.set(id, f);
  };
  const d = input.daemon || {};
  const live = input.mode === 'live';
  const running = !!d.started_by_us;
  const failed = (d.attempts || []).filter((a) => !a.ok && !/^Prøver igen/.test(a.text));

  if (input.driver?.installed === false) add('driver-missing');
  if (d.foreign?.length && !running) add('utility-running', d.foreign);

  if (!live) {
    const lastAttempt = (d.attempts || []).filter((a) => !/^Prøver igen/.test(a.text)).slice(-1)[0];
    const err = d.last_error || (lastAttempt && !lastAttempt.ok ? lastAttempt.text.replace(/^Stoppede: /, '') : null);
    if (!running && err) {
      const id = classifyError(err);
      add(id, [err, failed.length > 1 ? `Appen har prøvet at starte motoren ${failed.length} gange.` : null]);
    } else if (running) {
      add('no-device');
    } else if (!d.foreign?.length && input.driver?.installed !== false) {
      add(input.autoStart === false ? 'autostart-off' : 'engine-stopped');
    }
  }

  // The engine's own log (this run only): also problems while it works (USB dropping out …).
  for (const p of logProblems(sessionLines(input.log))) {
    if (live && ['old-instance', 'port-busy', 'tc-app', 'utility-running', 'pipe', 'log-dir', 'driver-missing'].includes(p.id)) continue;
    if (p.id === 'utility-running' && running) continue;
    add(p.id, p.lines);
  }
  // A stopped engine is explained by a more specific problem when there is one.
  if ([...out.keys()].some((id) => STOP_CAUSES.includes(id))) { out.delete('engine-stopped'); out.delete('engine-error'); }
  if (out.has('usb-open') || out.has('usb-unstable')) out.delete('no-device');
  return [...out.values()].sort((a, b) => LEVELS[a.level] - LEVELS[b.level]);
}

/** The finding the banner shows (problems with their own banner are left out). */
export function bannerFinding(findings, { skip = [] } = {}) {
  return (findings || []).find((f) => !skip.includes(f.id) && f.level !== 'info') || null;
}

export { DIAG as DIAG_FIX };
