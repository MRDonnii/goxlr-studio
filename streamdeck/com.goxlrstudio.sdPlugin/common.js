// Shared by the plugin and its settings pages: talking to GoXLR Studio's local API.
// The API must be switched on in GoXLR Studio (Indstillinger → Lokalt API); the token is copied
// from there. Only 127.0.0.1 is used – the plugin never leaves the pc.
/* exported GXS */
const GXS = {
  DEFAULT_PORT: 14610,
  url(g, path) {
    const port = Number(g?.port) || GXS.DEFAULT_PORT;
    const sep = path.includes('?') ? '&' : '?';
    return `http://127.0.0.1:${port}${path}${sep}token=${encodeURIComponent(g?.token || '')}`;
  },
  async get(g, path) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 1500);
    try {
      const r = await fetch(GXS.url(g, path), { signal: ctl.signal, cache: 'no-store' });
      if (r.status === 401) throw new Error('token');
      if (!r.ok) throw new Error(String(r.status));
      return await r.json();
    } finally { clearTimeout(t); }
  },
  /** "vol-set:Music|40" etc. */
  run(g, id) { return GXS.get(g, `/action/${encodeURIComponent(id)}`); },
  /** Danish when Stream Deck runs in Danish, otherwise English. */
  lang(info) { return /^da/i.test(info?.application?.language || navigator.language || '') ? 'da' : 'en'; },
  pct(v) { return Math.round(((Number(v) || 0) / 255) * 100); },
};
