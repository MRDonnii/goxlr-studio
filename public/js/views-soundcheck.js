// Lydtjek: Windows settings that change or hide the sound (soundcheck.rs), each with a fix, and
// advice for Discord. The findings come from soundcheckmodel.js.
import { h, toast, confirmDialog, logActivity } from './ui.js';
import { soundcheckReport, soundcheckSetDucking, soundcheckRestoreDucking, soundcheckSetEndpoint, setDefaultDevice, engineInfo, storeGet } from './native.js';
import { soundcheckFindings } from './soundcheckmodel.js';
import { engineTestSummary } from './views-outeq.js';

const MARK = { warn: '⚠', info: 'ℹ', ok: '✓' };

export function soundcheckView(ctx) {
  const list = h('div', { class: 'list soundcheck', 'data-testid': 'soundcheck' });
  const head = h('div', { class: 'hint', 'data-testid': 'soundcheck-summary' });

  const run = async () => {
    head.textContent = 'Tjekker …';
    const [r, info, test] = await Promise.all([
      soundcheckReport().catch((e) => ({ error: String(e.message || e) })),
      engineInfo().catch(() => null),
      storeGet('engine-test', null).catch(() => null),
    ]);
    if (r.error) { head.textContent = `Kunne ikke læse Windows' lydindstillinger: ${r.error}`; list.replaceChildren(); return; }
    const engine = info && {
      kind: info.kind,
      unregistered: info.kind === 'builtin' && !!info.registration && !info.registration.ok,
      summary: info.kind !== 'none' ? engineTestSummary(test?.tests, test?.sound) : null,
    };
    const found = soundcheckFindings(r, { engine });
    const warn = found.filter((f) => f.level === 'warn').length;
    const tips = found.filter((f) => f.level === 'info').length;
    head.textContent = !warn && !tips ? 'Alt ser godt ud.' : [warn && `${warn} ting bør rettes`, tips && `${tips} forslag`].filter(Boolean).join(' · ');
    list.replaceChildren(...found.map((f) => h('div', { class: `item sc-item sc-${f.level}`, 'data-testid': `soundcheck-${f.id}` },
      h('span', { class: 'sc-mark' }, MARK[f.level]),
      h('div', { class: 'sc-body' }, h('div', { class: 'sc-title' }, f.title), f.text ? h('div', { class: 'hint' }, f.text) : null),
      f.fix ? h('button', { class: `btn sm ${f.fix.quiet ? '' : 'primary'}`, 'data-testid': `soundcheck-fix-${f.id}`, onclick: () => fix(f.fix) }, f.fix.label) : null)));
  };

  const fix = async (x) => {
    try {
      switch (x.kind) {
        case 'ducking-off':
          await soundcheckSetDucking(3);
          logActivity('Lydtjek: Windows skruer ikke længere ned for andre lyde under opkald');
          toast('Slået fra – gælder fra næste opkald. Din gamle indstilling er gemt, så "Fortryd" kan sætte den tilbage.', 'info');
          break;
        case 'ducking-restore':
          await soundcheckRestoreDucking();
          logActivity('Lydtjek: Windows-dæmpning ved opkald sat tilbage');
          toast('Windows-indstillingen er sat tilbage, som den var', 'info');
          break;
        case 'unmute':
          await soundcheckSetEndpoint(x.id, null, false);
          break;
        case 'volume100':
          if (x.confirm && !(await confirmDialog('Sæt Windows-lydstyrken til 100 %?\n\nLyden bliver højere. Skru eventuelt ned på GoXLR’en først.', { ok: 'Sæt til 100 %' }))) return;
          await soundcheckSetEndpoint(x.id, 1, null);
          break;
        case 'default':
          await setDefaultDevice(x.id, 'all');
          break;
        case 'default-comm':
          await setDefaultDevice(x.id, 'comm');
          break;
        case 'page':
          ctx.navigate(x.page);
          return;
        default:
      }
    } catch (e) { toast(String(e.message || e)); }
    run();
  };

  run();
  const tip = (title, text) => h('div', { class: 'item sc-item' }, h('div', { class: 'sc-body' }, h('div', { class: 'sc-title' }, title), h('div', { class: 'hint' }, text)));
  return h('div', { class: 'grid' },
    h('div', { class: 'card' }, h('h2', {}, 'Lydtjek', h('button', { class: 'btn sm', 'data-testid': 'soundcheck-run', onclick: run }, 'Tjek igen')),
      head, list,
      h('div', { class: 'hint', style: { marginTop: '8px' } }, 'Tjekker de Windows-indstillinger, der kan ændre eller skjule lyden uden om GoXLR Studio. Intet ændres, før du trykker på en knap.')),
    h('div', { class: 'card' }, h('h2', {}, 'Discord og mikrofonen'),
      h('div', { class: 'list' },
        tip('Slå "Automatisk forstærkningskontrol" fra', 'Discord: Brugerindstillinger → Stemme og video (Automatic Gain Control). GoXLR’ens kompressor gør det samme bedre – kører begge, kæmper de, og stemmen "pumper".'),
        tip('Én støjfjerner ad gangen', 'Discords støjdæmpning (Krisp) er god mod tastatur og blæser. Sammen med en hård noise gate på GoXLR’en kan ord blive skåret af – lad den ene tage det meste, og sæt den anden mildt.'),
        tip('Ekkoannullering kan slås fra med hovedtelefoner', 'Den er til højttalere. Med hovedtelefoner gør den kun stemmen lidt mere "telefon".'),
        tip('Discords egen lydstyrke på 100 %', 'Styr vennernes lydstyrke på GoXLR’ens Chat-fader, så Discord ikke skruer ned for signalet først.'))));
}
