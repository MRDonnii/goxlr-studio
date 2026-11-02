import { h, toast } from './ui.js';
import { isNative, deckInfo, openUrl } from './native.js';
import { actionCatalog } from './actions.js';
import { prettyAccel } from './views-hotkeys.js';
import { deckLink, deckArgs, deckApiUrl } from './extras.js';

// Keys handed out by "Giv tast": combinations no normal program uses and every Stream Deck program
// can record by pressing them on the keyboard.
const KEY_POOL = [
  ...Array.from({ length: 12 }, (_, i) => `Ctrl+Alt+Shift+F${i + 1}`),
  ...['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'].map((d) => `Ctrl+Alt+Shift+${d}`),
];

const METHODS = [
  { id: 'link', label: 'Link' },
  { id: 'program', label: 'Program' },
  { id: 'key', label: 'Tast' },
  { id: 'web', label: 'Web-adresse' },
];

// Stream Deck: every action as a link, a program command, a key or a web address – with copy
// buttons and a guide for Streonor's, Elgato's and other button boxes' programs.
export function deckView(ctx) {
  const p = ctx.prefs;
  let method = METHODS.some((m) => m.id === p.deckMethod) ? p.deckMethod : 'link';
  let info = null;
  let catalog = [];
  let filter = '';

  const copy = (text, what) => navigator.clipboard.writeText(text)
    .then(() => toast(`${what} er kopieret – indsæt i Stream Deck-programmet`, 'info'))
    .catch((e) => toast(String(e)));

  const seg = h('div', { class: 'seg', 'data-testid': 'deck-method' });
  const guide = h('div', { class: 'deck-guide' });
  const list = h('div', { class: 'list deck-list' });
  const search = h('input', { type: 'text', placeholder: 'Søg handling, fx mute, Headset, Musik …', 'data-testid': 'deck-search', oninput: () => { filter = search.value.trim().toLowerCase(); renderList(); } });

  const renderSeg = () => seg.replaceChildren(...METHODS.map((m) => h('button', {
    class: m.id === method ? 'on' : '', 'data-testid': `deck-method-${m.id}`,
    onclick: () => { method = m.id; p.deckMethod = m.id; ctx.savePrefs(); render(); },
  }, m.label)));

  const linkStatus = () => {
    if (!info) return null;
    if (info.link_here) return h('span', { class: 'badge ok', 'data-testid': 'deck-link-ok' }, 'Link-typen er registreret i Windows');
    if (info.link_registered) return h('span', { class: 'badge warn', title: info.link_command || '' }, 'Linket peger på en anden GoXLR Studio');
    return h('span', { class: 'badge warn', 'data-testid': 'deck-link-missing' }, 'Ikke registreret');
  };

  const renderGuide = () => {
    const api = p.api || {};
    const parts = {
      link: [
        h('p', {}, 'I Stream Deck-programmet: læg handlingen ', h('b', {}, 'Website'), ' (kan også hedde "Åbn hjemmeside" eller "Open URL" – i Streonors program ligger den under System) på en tast, og indsæt linket fra listen nedenfor. Windows sender linket direkte til GoXLR Studio. Der åbnes ingen browser, og appen behøver ikke at køre i forvejen.'),
        h('div', { class: 'row', style: { flexWrap: 'wrap' } }, linkStatus(),
          h('button', { class: 'btn sm', 'data-testid': 'deck-test-link', disabled: !isNative(), onclick: () => openUrl(deckLink('deck-test')).catch((e) => toast(String(e))) }, 'Test linket')),
        info && !info.link_here ? h('p', { class: 'hint' }, 'Linket virker kun med den installerede GoXLR Studio (installeren registrerer det). Bruger du den portable exe, så vælg "Program" eller "Tast" i stedet.') : null,
        h('p', { class: 'hint' }, 'Åbner der alligevel en browser, når du trykker på tasten, så brug "Program" eller "Tast".'),
      ],
      program: [
        h('p', {}, 'Læg handlingen ', h('b', {}, 'Open'), ' ("Åbn" eller "Start program") på en tast. Vælg GoXLR Studio som program og skriv argumentet fra listen nedenfor i feltet til argumenter/parametre. Er der kun ét felt, så kopiér hele kommandoen.'),
        h('div', { class: 'row', style: { flexWrap: 'wrap' } },
          h('code', { class: 'deck-path', 'data-testid': 'deck-exe' }, info?.exe || '…'),
          h('button', { class: 'btn sm', disabled: !info?.exe, onclick: () => copy(info.exe, 'Programmets sti') }, 'Kopiér sti')),
      ],
      key: [
        h('p', {}, 'Giv handlingen en tast nedenfor. Læg derefter handlingen ', h('b', {}, 'Hotkey'), ' ("Genvejstast") på en tast i Stream Deck-programmet, klik i feltet og tryk de samme taster på tastaturet. Tasterne virker overalt i Windows – også i spil.'),
        h('p', { class: 'hint' }, 'Alle genveje kan ses og ændres under Genveje.'),
      ],
      web: [
        h('p', {}, 'Til Stream Deck-programmer, der kan sende web-forespørgsler: fx Elgato med plugin\'et "Web Requests" eller "API Ninja", Touch Portal og Home Assistant. Adressen virker kun på denne pc.'),
        api.enabled
          ? h('span', { class: 'badge ok' }, `Lokalt API kører på port ${api.port}`)
          : h('div', { class: 'row', style: { flexWrap: 'wrap' } }, h('span', { class: 'badge warn' }, 'Lokalt API er slået fra'),
            h('button', { class: 'btn sm primary', onclick: () => ctx.navigate('settings') }, 'Slå det til under Indstillinger')),
      ],
    };
    guide.replaceChildren(...parts[method].filter(Boolean));
  };

  const freeKey = () => KEY_POOL.find((k) => !ctx.hotkeys.some((b) => b.accel === k) && k !== p.discord?.accel && k !== p.discord?.deafAccel);
  const giveKey = async (item) => {
    const accel = freeKey();
    if (!accel) { toast('Alle Stream Deck-taster er brugt – giv handlingen en tast under Genveje'); return; }
    ctx.hotkeys.push({ id: crypto.randomUUID(), accel, action: item.id });
    await ctx.saveHotkeys();
    toast(`${item.label}: ${prettyAccel(accel)}`, 'info');
    renderList();
  };

  const value = (item) => {
    if (method === 'link') return deckLink(item.id);
    if (method === 'program') return deckArgs(item.id);
    if (method === 'web') return p.api?.enabled ? deckApiUrl(p.api, item.id) : '';
    return '';
  };
  const copyLabel = { link: 'Kopiér link', program: 'Kopiér argument', web: 'Kopiér adresse' };
  const copyWhat = { link: 'Linket', program: 'Argumentet', web: 'Adressen' };

  const row = (group, item) => {
    const v = value(item);
    let tail;
    if (method === 'key') {
      const b = ctx.hotkeys.find((x) => x.action === item.id && x.accel);
      tail = b
        ? h('span', { class: 'btn keycap sm', title: 'Ændres under Genveje' }, prettyAccel(b.accel))
        : h('button', { class: 'btn sm', 'data-testid': 'deck-give-key', onclick: () => giveKey(item) }, 'Giv tast');
    } else {
      tail = h('button', { class: 'btn sm primary', 'data-testid': 'deck-copy', disabled: !v, onclick: () => copy(v, copyWhat[method]) }, copyLabel[method]);
    }
    return h('div', { class: 'item deck-item', 'data-testid': 'deck-item' },
      h('div', { class: 'deck-label' }, h('div', {}, item.label), h('div', { class: 'hint' }, group)),
      v ? h('code', { class: 'deck-value', title: v }, v) : h('div', { class: 'spacer' }),
      tail,
      method === 'program' ? h('button', { class: 'btn sm', title: 'Hele kommandoen (program + argument)', disabled: !info?.exe, onclick: () => copy(`"${info.exe}" ${deckArgs(item.id)}`, 'Kommandoen') }, 'Hele kommandoen') : null,
      h('button', { class: 'btn sm', title: 'Kør handlingen nu', onclick: () => ctx.runAction(item.id, 'Test-knap under Stream Deck') }, 'Test'));
  };

  const renderList = () => {
    const rows = [];
    for (const g of catalog) {
      for (const i of g.items) {
        if (filter && !`${g.title} ${i.label} ${i.id}`.toLowerCase().includes(filter)) continue;
        rows.push(row(g.title, i));
      }
    }
    list.replaceChildren(...(rows.length ? rows : [h('div', { class: 'hint' }, filter ? 'Ingen handlinger passer til søgningen.' : 'Henter handlinger…')]));
  };

  const render = () => { renderSeg(); renderGuide(); renderList(); };

  deckInfo().then((i) => { info = i; render(); }).catch(() => {});
  actionCatalog(ctx).then((c) => { catalog = c; renderList(); });
  render();

  // Elgato's Stream Deck app: our plugin shows status on the keys (it reads the local API).
  const api = ctx.prefs.api || {};
  const pluginCard = h('div', { class: 'card', 'data-testid': 'deck-plugin' },
    h('h2', {}, 'Plugin til Elgato Stream Deck – med status'),
    h('div', { class: 'hint' }, 'Med pluginnet lyser tasterne, når det, de styrer, er slået til – fx rød, når mikrofonen er muted, eller når profilen/EQ-presettet er i brug. Der er også en lydstyrke-handling til drejeknapperne på Stream Deck +.'),
    h('ol', { class: 'deck-steps' },
      h('li', {}, 'Slå "Lokalt API" til under Indstillinger, og tryk "Kopiér token".',
        h('span', { class: `badge ${api.enabled ? 'ok' : 'warn'}`, style: { marginLeft: '6px' } }, api.enabled ? `API kører (port ${api.port || 14610})` : 'API er slået fra')),
      h('li', {}, 'Hent pluginnet og dobbeltklik på filen – Stream Deck-programmet installerer det.'),
      h('li', {}, 'Træk "GoXLR Studio-handling" ud på en tast, sæt token ind, og vælg handlingen.')),
    h('div', { class: 'row', style: { flexWrap: 'wrap' } },
      h('a', { class: 'btn sm primary', 'data-testid': 'deck-plugin-download', href: 'https://github.com/MRDonnii/goxlr-studio/releases/latest/download/GoXLR-Studio.streamDeckPlugin', target: '_blank', rel: 'noopener' }, 'Hent Stream Deck-plugin')),
    h('div', { class: 'hint', style: { marginTop: '6px' } }, 'Til Elgatos Stream Deck-program (version 6 eller nyere). Andre programmer, fx Streonor, bruger metoderne herunder.'));

  return h('div', { class: 'grid' },
    pluginCard,
    h('div', { class: 'card' },
      h('h2', {}, 'Stream Deck'),
      h('p', {}, 'Styr GoXLR Studio fra en Stream Deck – fx Streonor, Elgato eller Ulanzi. Hver handling i appen kan lægges på en tast. Vælg, hvordan dit Stream Deck-program skal starte den:'),
      seg, guide),
    h('div', { class: 'card' },
      h('h2', {}, 'Handlinger'),
      h('div', { class: 'row' }, search),
      list));
}
