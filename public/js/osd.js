const box = document.getElementById('box');
let t;
window.__TAURI__?.event.listen('osd', (ev) => {
  document.getElementById('text').textContent = ev.payload.text;
  box.className = `box ${ev.payload.kind || ''}`;
  requestAnimationFrame(() => box.classList.add('show'));
  clearTimeout(t);
  t = setTimeout(() => box.classList.remove('show'), 1350);
});
