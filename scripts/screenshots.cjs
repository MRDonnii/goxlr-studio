// Screenshots of GoXLR Studio's UI for the README (docs/screenshots).
//
//   STUDIO_PORT=14600 STUDIO_DATA=<empty dir> node server.js &
//   node scripts/screenshots.cjs docs/screenshots
//
// Uses the browser demo with the GoXLR Mini layout and sets the scene first (AutoHotkey import,
// built-in engines, a preset, a few scenes). The status line shows "Forbundet" as in the app with a
// GoXLR connected. The PNGs in the repo are afterwards reduced to 256 colours to stay small.
const { chromium } = require('playwright');
const OUT = process.argv[2];
(async () => {
  const b = await chromium.launch();
  const errors = [];
  const p = await b.newPage({ viewport: { width: 1360, height: 880 } });
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('dialog', (d) => d.accept());
  await p.goto('http://127.0.0.1:14600/?mini'); await p.waitForTimeout(3500);
  const nav = async (t) => { await p.click(`#nav button:has-text("${t}")`); await p.waitForTimeout(1300); await p.mouse.move(5, 870); };
  // Status line as in the app with a GoXLR connected.
  const live = () => p.evaluate(() => {
    const el = document.getElementById('conn');
    if (el) { el.className = 'conn live'; const l = el.querySelector('.label'); if (l) l.textContent = 'Forbundet'; }
    // Browser-only hints (the Windows app shows its own text there).
    for (const d of document.querySelectorAll('.hint')) {
      if (/^(Demo-data|I browseren)/.test(d.textContent.trim())) d.remove();
    }
    for (const d of document.querySelectorAll('.item')) {
      for (const n of d.childNodes) if (n.nodeType === 3 && n.textContent === 'Demo (ingen GoXLR-motor)') n.textContent = 'Live';
    }
  });
  // Questions are asked in the app's own dialogs (not window.confirm): answer OK.
  const okDialogs = async () => {
    for (let i = 0; i < 4; i++) {
      const b = p.locator('[data-testid=dialog-ok]');
      if (!(await b.count())) return;
      await b.first().click(); await p.waitForTimeout(700);
    }
  };
  const shot = async (name, opts = {}) => { await live(); await p.waitForTimeout(150); await p.screenshot({ path: `${OUT}/${name}.png`, ...opts }); console.log('shot', name); };

  // Set the scene: import the AutoHotkey shortcuts, move the EQ to the built-in engine, pick a preset.
  await nav('Overflytning');
  await p.click('button:has-text("Tag fuld backup nu")').catch(() => {}); await p.waitForTimeout(500); await okDialogs();
  await p.locator('button:has-text("Importér")').filter({ hasText: 'genveje' }).first().click().catch((e) => console.log('no import', e.message)); await p.waitForTimeout(600);
  await p.click('button:has-text("Husk nuværende lyd pr. app")').catch(() => {}); await p.waitForTimeout(500);
  await nav('Indstillinger');
  await p.click('button:has-text("Brug den indbyggede motor nu")').catch((e) => console.log('no takeover', e.message)); await p.waitForTimeout(800); await okDialogs();
  await nav('Mikrofon');
  // A typical voice EQ instead of a flat line.
  const gains = ['-3', '-1', '0', '1', '3', '2'];
  const gainInputs = p.locator('.card:has(h2:has-text("Mikrofon-EQ")) input[type="number"]');
  const n = await gainInputs.count();
  console.log('mic inputs', n);
  for (let i = 0; i < 6; i++) {
    const input = gainInputs.nth(i * 2 + 1);
    await input.fill(gains[i]); await input.press('Enter'); await p.waitForTimeout(120);
  }
  await nav('Afspilnings-EQ');
  await p.locator('.card:has(h2:has-text("EQ-motor")) button:has-text("Erstat med indbygget motor")').click(); await p.waitForTimeout(1000); await okDialogs(); await p.waitForTimeout(1500);
  await p.click('button:has-text("Fodtrin (FPS)")').catch((e) => console.log('no preset', e.message)); await p.waitForTimeout(800);

  // A few scenes.
  await nav('Scener');
  for (const name of ['Gaming', 'Stream', 'Film']) {
    await p.fill('input[placeholder^="Navn"]', name);
    await p.click('button:has-text("Gem scene")'); await p.waitForTimeout(400);
  }

  await nav('Mixer'); await p.waitForTimeout(600);
  await shot('mixer');
  await nav('Mikrofon'); await shot('mikrofon');
  await nav('Afspilnings-EQ'); await shot('afspilnings-eq');
  const eng = p.locator('.card:has(h2:has-text("EQ-motor"))');
  await eng.scrollIntoViewIfNeeded(); await p.waitForTimeout(300);
  await live(); await eng.screenshot({ path: `${OUT}/eq-motor.png` }); console.log('shot eq-motor');
  await p.evaluate(() => window.scrollTo(0, 0));
  await nav('Routing'); await shot('routing');
  await nav('Lyd pr. app'); await shot('lyd-pr-app');
  await nav('Scener'); await shot('scener');
  await nav('Lys'); await shot('lys');
  await nav('Profiler'); await shot('profiler');
  await nav('Genveje'); await shot('genveje');
  await nav('Stream Deck'); await shot('stream-deck');
  await nav('Overflytning'); await shot('overflytning');
  await nav('Diagnose'); await p.waitForTimeout(800); await shot('diagnose');
  await nav('Indstillinger'); await shot('indstillinger');
  // Command palette (Ctrl+K)
  await nav('Mixer');
  await p.keyboard.press('Control+k'); await p.waitForTimeout(500);
  await p.keyboard.type('spe'); await p.waitForTimeout(400);
  await shot('kommandopalet');
  await p.keyboard.press('Escape');

  // The small on-screen message shown over games when a shortcut is used.
  const o = await b.newPage({ viewport: { width: 520, height: 120 } });
  await o.goto('http://127.0.0.1:14600/osd.html'); await o.waitForTimeout(300);
  await o.evaluate(() => {
    document.documentElement.style.background = '#05070c';
    document.getElementById('text').textContent = 'Profil: Speakers · EQ: Fodtrin (FPS)';
    document.getElementById('box').className = 'box ok show';
  });
  await o.waitForTimeout(400);
  await o.screenshot({ path: `${OUT}/osd.png` }); console.log('shot osd');

  console.log('ERRORS', errors);
  await b.close();
})();
