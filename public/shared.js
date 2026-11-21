// Shared client helpers: login (PIN pad), API, live updates (SSE), small UI utils.
const FK = {
  token: localStorage.getItem('fk_token') || '', user: JSON.parse(localStorage.getItem('fk_user') || 'null'), state: null, opts: null,
};
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rs = (n) => '₹' + (Math.round(n * 100) / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const dietDot = (d) => `<span class="diet ${esc(d)}" title="${esc(d)}"></span>`;
const mins = (t) => Math.max(0, Math.floor((Date.now() - t) / 60000));
const LOGO = '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 16h24a12 12 0 0 1-24 0z"/><path d="M11 10c0-2 2-2 2-4M17 10c0-2 2-2 2-4"/></svg>';

function toast(msg, bad) {
  const t = Object.assign(document.createElement('div'), { className: 'toast' + (bad ? ' bad' : ''), textContent: msg });
  document.body.append(t); setTimeout(() => t.remove(), 2600);
}
async function api(method, url, body) {
  let r;
  try {
    r = await fetch(url, { method, headers: { 'Content-Type': 'application/json', 'x-token': FK.token }, body: body ? JSON.stringify(body) : undefined });
  } catch { toast('No connection to server', true); throw new Error('offline'); }
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && FK.user) { logout(); throw new Error('auth'); }
  if (!r.ok) { toast(j.error || 'Something went wrong', true); throw new Error(j.error || r.status); }
  return j;
}
// run an action, swallow the (already toasted) error
const act = (p) => p.catch(() => {});

function logout() {
  localStorage.removeItem('fk_token'); localStorage.removeItem('fk_user'); location.reload();
}
function modal(html, onMount) {
  const o = document.createElement('div'); o.className = 'overlay'; o.innerHTML = `<div class="modal">${html}</div>`;
  o.addEventListener('mousedown', (e) => { if (e.target === o) o.remove(); });
  document.body.append(o); onMount && onMount(o, () => o.remove()); return o;
}

function loginScreen(roles) {
  return new Promise((resolve) => {
    let pin = '';
    const o = document.createElement('div'); o.className = 'overlay';
    o.innerHTML = `<div class="card login"><div class="brand" style="justify-content:center;font-size:22px">${LOGO} Flavours Kitchen</div>
      <p class="muted" id="who">Enter your PIN</p><div class="pin"></div><div class="err"></div>
      <div class="keys">${[1, 2, 3, 4, 5, 6, 7, 8, 9, '⌫', 0, '✓'].map((k) => `<button class="btn" data-k="${k}" aria-label="${k}">${k}</button>`).join('')}</div></div>`;
    document.body.append(o);
    const dots = $('.pin', o), err = $('.err', o);
    const draw = () => { dots.innerHTML = '<i class="' + (pin.length ? 'on' : '') + '"></i>'.repeat(1) + [...Array(Math.max(3, pin.length))].slice(1).map((_, i) => `<i class="${i + 1 < pin.length ? 'on' : ''}"></i>`).join(''); };
    draw();
    async function submit() {
      try {
        const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin }) });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error);
        if (roles && !roles.includes(j.user.role)) throw new Error('This screen is not for the ' + j.user.role + ' role');
        FK.token = j.token; FK.user = j.user;
        localStorage.setItem('fk_token', j.token); localStorage.setItem('fk_user', JSON.stringify(j.user));
        o.remove(); resolve();
      } catch (e) { err.textContent = e.message || 'Could not sign in'; pin = ''; draw(); }
    }
    function key(k) {
      err.textContent = '';
      if (k === '⌫') pin = pin.slice(0, -1); else if (k === '✓') return pin.length >= 4 && submit(); else if (pin.length < 6) pin += k;
      draw();
    }
    o.addEventListener('click', (e) => { const b = e.target.closest('[data-k]'); if (b) key(b.dataset.k); });
    document.addEventListener('keydown', function h(e) {
      if (!document.body.contains(o)) return document.removeEventListener('keydown', h);
      if (/^\d$/.test(e.key)) key(e.key); else if (e.key === 'Backspace') key('⌫'); else if (e.key === 'Enter') key('✓');
    });
  });
}

async function refresh() {
  try { FK.state = await api('GET', '/api/state'); FK.opts.onState && FK.opts.onState(FK.state); } catch {}
}
function connect() {
  const es = new EventSource('/api/stream?token=' + FK.token);
  const dot = $('#conn');
  es.onopen = () => { dot && dot.classList.remove('off'); refresh(); };
  es.onerror = () => dot && dot.classList.add('off');
  es.onmessage = (e) => { refresh(); const m = JSON.parse(e.data); FK.opts.onEvent && FK.opts.onEvent(m); };
}
// opts: { roles, onState, onEvent }
async function boot(opts) {
  FK.opts = opts;
  if (FK.token && FK.user && (!opts.roles || opts.roles.includes(FK.user.role))) {
    try { await api('GET', '/api/state'); } catch { FK.token = ''; }
  } else FK.token = '';
  if (!FK.token) await loginScreen(opts.roles);
  $$('[data-user]').forEach((e) => (e.textContent = FK.user.name));
  $$('[data-logout]').forEach((e) => e.addEventListener('click', logout));
  await refresh(); connect();
  opts.onReady && opts.onReady();
}
// print a text receipt through the browser (fallback if no thermal printer is reachable)
function browserPrint(text) {
  let el = $('#rcpt'); if (!el) { el = document.createElement('div'); el.id = 'rcpt'; document.body.append(el); }
  el.textContent = text; window.print();
}
