// Rene stemmer i chatten: noise removal (RNNoise, an open-source neural network) on the voices you
// hear – a friend's keyboard, fan or dog – before they reach your ears. Runs in the EQ engine as a
// VST plugin on the GoXLR's Chat output (Discord etc.), so it needs the engine on that output.
// Your own mic is not touched: the GoXLR's gate and the mic EQ handle that in the hardware.
import { h, toast } from './ui.js';
import { engineInfo, engineTask, listAudioDevices } from './native.js';
import { channelEndpoint } from './extras.js';

export function chatDenoiseCard(ctx, { state, save, apply }) {
  state.chatDenoise ??= { enabled: false };
  const body = h('div', { 'data-testid': 'chat-denoise' });
  const render = async () => {
    const [info, devs] = await Promise.all([engineInfo().catch(() => null), listAudioDevices().catch(() => [])]);
    const chatId = channelEndpoint('Chat', devs);
    const onChat = !!info?.devices?.some((d) => d.installed && chatId && d.id.toLowerCase() === chatId.toLowerCase());
    const sw = h('input', { type: 'checkbox', 'data-testid': 'chat-denoise-on', checked: !!state.chatDenoise.enabled, onchange: () => { state.chatDenoise.enabled = sw.checked; save(); apply(); render(); } });
    const notes = [];
    if (!chatId) notes.push('Fandt ikke GoXLR’ens Chat-udgang.');
    else if (info && info.kind === 'builtin' && !onChat) notes.push('EQ-motoren er ikke sat på Chat-udgangen – gør det under "EQ-motor" ovenfor (eller "Sæt motoren på" i EQ pr. kanal).');
    if (info && info.kind !== 'builtin') notes.push('Kræver GoXLR Studios EQ-motor.');
    else if (info && !info.denoise_bundled) notes.push('Denne udgave af appen har ikke støjfjerneren med.');
    const needFiles = info?.kind === 'builtin' && info.denoise_bundled && !info.denoise_installed;
    body.replaceChildren(
      h('div', { class: 'row' }, h('label', {}, 'Fjern støj fra vennernes stemmer'), h('div', { class: 'spacer' }), h('label', { class: 'switch' }, sw, h('span'))),
      ...notes.map((n) => h('div', { class: 'hint warn-text' }, n)),
      needFiles ? h('div', { class: 'row', style: { marginTop: '6px' } }, h('span', { class: 'hint' }, 'Støjfjerneren skal lægges ved EQ-motoren først (kræver administrator).'),
        h('button', { class: 'btn sm primary', 'data-testid': 'chat-denoise-install', onclick: async (e) => {
          e.target.disabled = true;
          try { const r = await engineTask({ action: 'test' }); toast(r?.ok ? 'Støjfjerneren er lagt ind' : `Det lykkedes ikke: ${r?.error || '?'}`, r?.ok ? 'info' : 'error'); } catch (err) { toast(String(err)); }
          apply(); render();
        } }, 'Læg den ind')) : '',
      h('div', { class: 'hint', style: { marginTop: '6px' } }, 'Tastatur, blæser, hund og andet baggrundsstøj fjernes fra det, du hører i Chat-kanalen (Discord m.fl.) – med RNNoise, et lille neuralt netværk, der kører på din CPU. Giver ca. 30 ms forsinkelse og virker kun, når Chat-udgangen kører 48 kHz. Din egen mikrofon røres ikke.'));
  };
  render();
  return h('div', { class: 'card' }, h('h2', {}, 'Rene stemmer i chatten'), body);
}
