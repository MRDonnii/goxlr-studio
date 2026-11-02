// Dynamik (limiter/compressor plugin, plugins/dynamics): the pure maths – settings in dB/ms/ratio
// → the plugin's 8 normalised parameters, mirroring plugins/dynamics/src/lib.rs (map::*).
export const DYN_MODES = {
  limiter: { label: 'Limiter – beskyt mod spidser', threshold: -20, ratio: 1, attack: 5, release: 150, makeup: 0, ceiling: -1, limRelease: 50 },
  gentle: { label: 'Let kompression', threshold: -18, ratio: 2, attack: 10, release: 200, makeup: 3, ceiling: -1, limRelease: 50 },
  night: { label: 'Natmode – jævn lydstyrke', threshold: -32, ratio: 4, attack: 5, release: 300, makeup: 10, ceiling: -1, limRelease: 80 },
};

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const r4 = (v) => Math.round(clamp01(v) * 10000) / 10000;
const logPos = (v, lo, span) => Math.log(Math.max(v, lo) / lo) / Math.log(span);

/** Settings (dB, ms, ratio) → the plugin's 8 normalised parameters. */
export function dynamicsParams(s) {
  return [
    r4((Number(s.threshold) + 40) / 40),
    r4((Number(s.ratio) - 1) / 19),
    r4(logPos(Number(s.attack), 0.1, 1000)),
    r4(logPos(Number(s.release), 10, 200)),
    r4(Number(s.makeup) / 24),
    s.limiter === false ? 0 : 1,
    r4((Number(s.ceiling) + 12) / 12),
    r4(logPos(Number(s.limRelease), 1, 1000)),
  ];
}

/** What enginePayload sends (null when off). */
export function dynamicsPayload(d) {
  if (!d?.enabled) return null;
  return { params: dynamicsParams({ ...DYN_MODES.limiter, ...d }) };
}

