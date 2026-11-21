// Flavours Kitchen - restaurant system server (no npm dependencies).
// Run: node server.js   ->  http://localhost:3000
const http = require('http');
const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const seed = require('./menu-seed');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PRINT_DIR = path.join(DATA_DIR, 'prints');
fs.mkdirSync(PRINT_DIR, { recursive: true });

// ---------- database (JSON file) ----------
const uid = (p = '') => p + crypto.randomBytes(4).toString('hex');
function defaultDb() {
  return {
    settings: {
      name: 'Flavours Kitchen', address: 'Hyderabad', phone: '', gstin: '', fssai: '',
      gstPercent: 5, serviceChargePercent: 0, footer: 'Thank you! Visit again.',
      stations: [
        { id: 'tiffin', name: 'Tiffin Counter' }, { id: 'main', name: 'Main Kitchen' },
        { id: 'chinese', name: 'Chinese' }, { id: 'fry', name: 'Fry / Tandoor' },
        { id: 'snack', name: 'Snacks & Chat' }, { id: 'beverage', name: 'Juice & Chai Bar' },
      ],
    },
    staff: [
      { id: 's1', name: 'Owner', role: 'admin', pin: '1111' },
      { id: 's2', name: 'Waiter 1', role: 'waiter', pin: '2222' },
      { id: 's3', name: 'Head Chef', role: 'kitchen', pin: '3333' },
    ],
    categories: seed.categories,
    menu: seed.items,
    tables: Array.from({ length: 12 }, (_, i) => ({ id: 'T' + (i + 1), name: 'Table ' + (i + 1), seats: 4, cleaning: false })),
    orders: [],
    counters: { order: 0, kot: 0, bill: 0 },
    // printers: type kot|bill; host empty => "virtual" printer (output saved to data/prints)
    printers: [
      { id: 'p-bill', name: 'Billing Printer', type: 'bill', host: '', port: 9100, width: 42, stations: [] },
      { id: 'p-kitchen', name: 'Kitchen Printer', type: 'kot', host: '', port: 9100, width: 42, stations: ['main', 'chinese', 'fry', 'tiffin', 'snack', 'beverage'] },
    ],
    printJobs: [],
    audit: [],
  };
}
let db;
try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { db = defaultDb(); }
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 1));
    fs.renameSync(tmp, DB_FILE);
  }, 150);
}
function audit(user, action, detail = '') {
  db.audit.unshift({ t: Date.now(), user: user ? user.name : 'system', action, detail });
  db.audit.length = Math.min(db.audit.length, 500);
}

// ---------- sessions + live updates ----------
const sessions = new Map(); // token -> staff
const clients = new Set();
let pendingBroadcast = null;
function broadcast(kind = 'state') {
  clearTimeout(pendingBroadcast);
  pendingBroadcast = setTimeout(() => {
    for (const c of clients) c.write(`data: ${JSON.stringify({ kind, t: Date.now() })}\n\n`);
  }, 40);
}
setInterval(() => { for (const c of clients) c.write(': ping\n\n'); }, 25000);

// ---------- helpers ----------
const money = (n) => Math.round(n * 100) / 100;
function orderTotals(o) {
  const items = o.items.filter((i) => i.status !== 'void');
  const subtotal = items.reduce((s, i) => s + i.price * i.qty, 0);
  const discount = Math.min(o.discount || 0, subtotal);
  const net = subtotal - discount;
  const service = money(net * (db.settings.serviceChargePercent / 100));
  const gst = money((net + service) * (db.settings.gstPercent / 100));
  const total = Math.round(net + service + gst);
  return { subtotal, discount, service, gst, total, roundOff: money(total - (net + service + gst)) };
}
function tableStatus(t) {
  const o = db.orders.find((x) => x.tableId === t.id && x.status === 'open');
  if (o) {
    const live = o.items.filter((i) => i.status !== 'void');
    if (o.billRequested) return 'bill';
    if (live.some((i) => i.status === 'ready')) return 'ready';
    return 'occupied';
  }
  return t.cleaning ? 'cleaning' : 'free';
}
function publicState() {
  const since = Date.now() - 36 * 3600 * 1000;
  return {
    now: Date.now(),
    settings: db.settings,
    categories: db.categories,
    menu: db.menu,
    tables: db.tables.map((t) => ({ ...t, status: tableStatus(t), orderId: (db.orders.find((o) => o.tableId === t.id && o.status === 'open') || {}).id })),
    orders: db.orders.filter((o) => o.status === 'open' || (o.closedAt || 0) > since).map((o) => ({ ...o, totals: orderTotals(o) })),
  };
}
function body(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 2e6) req.destroy(); });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(e); } });
  });
}
function send(res, code, obj, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(obj) : obj);
}

// ---------- ESC/POS thermal printing ----------
const ESC = 0x1b, GS = 0x1d;
class Escpos {
  constructor(width = 42) { this.w = width; this.b = []; this.init(); }
  raw(...x) { this.b.push(...x); return this; }
  init() { return this.raw(ESC, 0x40); }
  text(s) { this.b.push(...Buffer.from(String(s).replace(/[^\x20-\x7e\n]/g, '?'), 'latin1')); return this; }
  line(s = '') { return this.text(s + '\n'); }
  align(a) { return this.raw(ESC, 0x61, { left: 0, center: 1, right: 2 }[a]); }
  bold(on) { return this.raw(ESC, 0x45, on ? 1 : 0); }
  size(w, h) { return this.raw(GS, 0x21, ((w - 1) << 4) | (h - 1)); }
  hr(c = '-') { return this.line(c.repeat(this.w)); }
  lr(l, r) { const sp = Math.max(1, this.w - l.length - r.length); return this.line(l + ' '.repeat(sp) + r); }
  feed(n = 1) { return this.raw(ESC, 0x64, n); }
  cut() { return this.feed(4).raw(GS, 0x56, 0x42, 0x00); }
  buffer() { return Buffer.from(this.b); }
  // plain text preview of what was printed (used for virtual printers + UI preview)
  static toText(buf) {
    let out = ''; const a = [...buf];
    for (let i = 0; i < a.length; i++) {
      const c = a[i];
      if (c === ESC) { i += (a[i + 1] === 0x40 ? 1 : a[i + 1] === 0x64 || a[i + 1] === 0x61 || a[i + 1] === 0x45 ? 2 : 1); continue; }
      if (c === GS) { i += a[i + 1] === 0x56 ? 3 : 2; continue; }
      out += String.fromCharCode(c);
    }
    return out;
  }
}
const wrap = (s, w) => { const out = []; while (s.length > w) { let k = s.lastIndexOf(' ', w); if (k < 1) k = w; out.push(s.slice(0, k)); s = s.slice(k).trim(); } out.push(s); return out; };
const when = (t) => new Date(t).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true });

function buildKot(order, kotNo, stationId, items, width) {
  const st = db.settings.stations.find((s) => s.id === stationId);
  const p = new Escpos(width);
  p.align('center').bold(true).size(2, 2).line('KOT #' + kotNo).size(1, 1).line(st ? st.name : stationId).bold(false);
  p.hr('=').align('left');
  p.bold(true).size(1, 2).line(order.type === 'dinein' ? tableName(order.tableId) : 'TAKEAWAY ' + (order.customer || '')).size(1, 1).bold(false);
  p.line('Order #' + order.no + '   ' + when(Date.now()));
  if (order.waiter) p.line('Waiter: ' + order.waiter);
  p.hr();
  for (const i of items) {
    p.bold(true).size(1, 2);
    for (const [k, l] of wrap(`${i.qty} x ${i.name}`, width).entries()) p.line(k ? '    ' + l : l);
    p.size(1, 1).bold(false);
    if (i.note) for (const l of wrap('  >> ' + i.note, width)) p.line(l);
  }
  p.hr().feed(1).cut();
  return p.buffer();
}
function buildBill(order, width, copy = '') {
  const s = db.settings, t = orderTotals(order);
  const p = new Escpos(width);
  p.align('center').bold(true).size(2, 2).line(s.name).size(1, 1).bold(false);
  if (s.address) p.line(s.address);
  if (s.phone) p.line('Ph: ' + s.phone);
  if (s.gstin) p.line('GSTIN: ' + s.gstin);
  if (s.fssai) p.line('FSSAI: ' + s.fssai);
  p.hr('=').align('left');
  p.lr('Bill #' + (order.billNo || '-'), when(Date.now()));
  p.line(order.type === 'dinein' ? tableName(order.tableId) : 'Takeaway ' + (order.customer || ''));
  if (order.waiter) p.line('Waiter: ' + order.waiter);
  p.hr();
  const qW = 4, aW = 9, nW = width - qW - aW - 1;
  p.bold(true).line('Item'.padEnd(nW + 1) + 'Qty'.padStart(qW - 1) + ' ' + 'Amount'.padStart(aW - 1)).bold(false).hr();
  for (const i of order.items.filter((x) => x.status !== 'void')) {
    const ls = wrap(i.name, nW);
    ls.forEach((l, k) => p.line(k === ls.length - 1
      ? l.padEnd(nW + 1) + String(i.qty).padStart(qW - 1) + ' ' + (i.price * i.qty).toFixed(2).padStart(aW - 1)
      : l));
  }
  p.hr();
  p.lr('Subtotal', t.subtotal.toFixed(2));
  if (t.discount) p.lr('Discount', '-' + t.discount.toFixed(2));
  if (t.service) p.lr(`Service ${s.serviceChargePercent}%`, t.service.toFixed(2));
  if (s.gstPercent) { p.lr(`CGST ${s.gstPercent / 2}%`, (t.gst / 2).toFixed(2)); p.lr(`SGST ${s.gstPercent / 2}%`, (t.gst / 2).toFixed(2)); }
  if (t.roundOff) p.lr('Round off', t.roundOff.toFixed(2));
  p.hr('=').bold(true).size(1, 2).lr('TOTAL', 'Rs ' + t.total.toFixed(2)).size(1, 1).bold(false).hr('=');
  if (order.payment) p.line('Paid by: ' + order.payment.method.toUpperCase());
  p.align('center').feed(1).line(s.footer || '').line(copy).feed(1).cut();
  return p.buffer();
}
const tableName = (id) => (db.tables.find((t) => t.id === id) || { name: id }).name;

// Print queue with automatic retry
function enqueue(printerId, title, data, meta = {}) {
  const job = { id: uid('j'), printerId, title, data: data.toString('base64'), status: 'queued', attempts: 0, error: '', created: Date.now(), ...meta };
  db.printJobs.unshift(job);
  db.printJobs.length = Math.min(db.printJobs.length, 200);
  save(); broadcast('print');
  runJob(job);
  return job;
}
function sendToPrinter(printer, buf) {
  return new Promise((resolve, reject) => {
    if (!printer.host) { // virtual printer: save to disk so it can be inspected / tested without hardware
      const f = path.join(PRINT_DIR, `${Date.now()}-${printer.id}`);
      fs.writeFileSync(f + '.bin', buf); fs.writeFileSync(f + '.txt', Escpos.toText(buf));
      return resolve();
    }
    const sock = net.createConnection({ host: printer.host, port: printer.port || 9100 });
    sock.setTimeout(4000);
    sock.on('connect', () => sock.end(buf));
    sock.on('close', (err) => (err ? reject(new Error('connection error')) : resolve()));
    sock.on('timeout', () => { sock.destroy(); reject(new Error('printer timeout')); });
    sock.on('error', (e) => reject(e));
  });
}
async function runJob(job) {
  const printer = db.printers.find((p) => p.id === job.printerId);
  job.attempts++; job.status = 'printing';
  try {
    if (!printer) throw new Error('printer removed');
    await sendToPrinter(printer, Buffer.from(job.data, 'base64'));
    job.status = 'done'; job.error = '';
  } catch (e) {
    job.error = e.message;
    if (job.attempts < 3) { job.status = 'retrying'; setTimeout(() => runJob(job), 3000 * job.attempts); }
    else job.status = 'failed';
  }
  save(); broadcast('print');
}
function printKots(order, kotNo, newItems) {
  const byStation = {};
  for (const i of newItems) (byStation[i.station] = byStation[i.station] || []).push(i);
  for (const [stationId, items] of Object.entries(byStation)) {
    const printer = db.printers.find((p) => p.type === 'kot' && p.stations.includes(stationId));
    if (printer) enqueue(printer.id, `KOT ${kotNo} ${stationId}`, buildKot(order, kotNo, stationId, items, printer.width), { orderId: order.id });
  }
}
function printBill(order, copy = '') {
  const printer = db.printers.find((p) => p.type === 'bill');
  if (!printer) return null;
  return enqueue(printer.id, `Bill ${order.billNo || order.no}`, buildBill(order, printer.width, copy), { orderId: order.id });
}

// ---------- routes ----------
const routes = [];
const route = (method, pattern, roles, fn) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), roles, fn });
const R_ALL = ['admin', 'waiter', 'kitchen'], R_FLOOR = ['admin', 'waiter'], R_ADMIN = ['admin'], R_KITCHEN = ['admin', 'kitchen'];

route('POST', '/api/login', null, async (req, res, { b }) => {
  const s = db.staff.find((x) => x.pin === String(b.pin));
  if (!s) return send(res, 401, { error: 'Wrong PIN' });
  const token = crypto.randomBytes(16).toString('hex');
  sessions.set(token, s); audit(s, 'login');
  send(res, 200, { token, user: { id: s.id, name: s.name, role: s.role } });
});
route('GET', '/api/state', R_ALL, (req, res) => send(res, 200, publicState()));

// ---- orders
route('POST', '/api/orders/send', R_FLOOR, (req, res, { b, user }) => {
  // b: { tableId?, type: dinein|takeaway, customer?, items:[{menuId, qty, note}] }
  if (!Array.isArray(b.items) || !b.items.length) return send(res, 400, { error: 'No items' });
  let order = b.type === 'takeaway' ? null : db.orders.find((o) => o.tableId === b.tableId && o.status === 'open');
  if (b.type !== 'takeaway' && !db.tables.find((t) => t.id === b.tableId)) return send(res, 400, { error: 'Unknown table' });
  if (!order) {
    order = { id: uid('o'), no: ++db.counters.order, type: b.type === 'takeaway' ? 'takeaway' : 'dinein', tableId: b.tableId || null, customer: b.customer || '', waiter: user.name, status: 'open', items: [], discount: 0, created: Date.now() };
    db.orders.push(order);
    const t = db.tables.find((x) => x.id === b.tableId); if (t) t.cleaning = false;
  }
  order.billRequested = false;
  const kotNo = ++db.counters.kot, now = Date.now(), added = [];
  for (const it of b.items) {
    const m = db.menu.find((x) => x.id === it.menuId);
    if (!m) continue;
    if (!m.available) return send(res, 409, { error: m.name + ' is out of stock' });
    const cat = db.categories.find((c) => c.id === m.categoryId);
    const line = { id: uid('i'), menuId: m.id, name: m.name, price: m.price, diet: m.diet, qty: Math.max(1, Math.min(99, +it.qty || 1)), note: (it.note || '').slice(0, 120), station: cat ? cat.station : 'main', kot: kotNo, status: 'new', sentAt: now };
    order.items.push(line); added.push(line);
  }
  printKots(order, kotNo, added);
  audit(user, 'order.send', `#${order.no} KOT ${kotNo}`);
  save(); broadcast();
  send(res, 200, { orderId: order.id, kotNo });
});
// item/ticket status: start (cooking), ready, recall, served, void
route('POST', '/api/orders/:id/status', R_ALL, (req, res, { b, params, user }) => {
  const o = db.orders.find((x) => x.id === params.id);
  if (!o) return send(res, 404, { error: 'Order not found' });
  const status = b.status;
  if (!['new', 'cooking', 'ready', 'served', 'void'].includes(status)) return send(res, 400, { error: 'Bad status' });
  if (user.role === 'kitchen' && !['cooking', 'ready', 'new'].includes(status)) return send(res, 403, { error: 'Not allowed' });
  const now = Date.now();
  for (const i of o.items) {
    const hit = b.itemIds ? b.itemIds.includes(i.id) : (b.kot ? i.kot === b.kot && (!b.station || i.station === b.station) : false);
    if (!hit || i.status === 'void') continue;
    if (status === 'void') { audit(user, 'item.void', `#${o.no} ${i.name}`); }
    i.status = status;
    if (status === 'cooking') i.startedAt = now;
    if (status === 'ready') i.readyAt = now;
    if (status === 'served') i.servedAt = now;
    if (status === 'new') { delete i.startedAt; delete i.readyAt; }
  }
  save(); broadcast(); send(res, 200, { ok: true });
});
route('POST', '/api/orders/:id/billreq', R_FLOOR, (req, res, { params }) => {
  const o = db.orders.find((x) => x.id === params.id); if (!o) return send(res, 404, { error: 'Not found' });
  o.billRequested = true; save(); broadcast(); send(res, 200, { ok: true });
});
route('POST', '/api/orders/:id/discount', R_FLOOR, (req, res, { b, params, user }) => {
  const o = db.orders.find((x) => x.id === params.id); if (!o) return send(res, 404, { error: 'Not found' });
  o.discount = Math.max(0, +b.amount || 0); audit(user, 'discount', `#${o.no} ${o.discount}`);
  save(); broadcast(); send(res, 200, { ok: true });
});
route('POST', '/api/orders/:id/printbill', R_FLOOR, (req, res, { params, user }) => {
  const o = db.orders.find((x) => x.id === params.id); if (!o) return send(res, 404, { error: 'Not found' });
  if (!o.billNo) o.billNo = ++db.counters.bill;
  const job = printBill(o, o.billPrinted ? '** DUPLICATE **' : '');
  o.billPrinted = (o.billPrinted || 0) + 1; audit(user, 'bill.print', `#${o.no}`);
  save(); broadcast(); send(res, 200, { ok: true, queued: !!job, billNo: o.billNo });
});
route('POST', '/api/orders/:id/pay', R_FLOOR, (req, res, { b, params, user }) => {
  const o = db.orders.find((x) => x.id === params.id); if (!o) return send(res, 404, { error: 'Not found' });
  if (o.status !== 'open') return send(res, 409, { error: 'Already closed' });
  if (!['cash', 'upi', 'card'].includes(b.method)) return send(res, 400, { error: 'Pick a payment method' });
  if (!o.billNo) o.billNo = ++db.counters.bill;
  o.payment = { method: b.method, amount: orderTotals(o).total, at: Date.now() };
  o.status = 'paid'; o.closedAt = Date.now();
  o.items.forEach((i) => { if (i.status !== 'void') i.status = 'served'; });
  const t = db.tables.find((x) => x.id === o.tableId); if (t) t.cleaning = true;
  if (b.print) printBill(o);
  audit(user, 'order.pay', `#${o.no} ${b.method} ${o.payment.amount}`);
  save(); broadcast(); send(res, 200, { ok: true });
});
route('POST', '/api/tables/:id/transfer', R_FLOOR, (req, res, { b, params, user }) => {
  const o = db.orders.find((x) => x.tableId === params.id && x.status === 'open');
  const to = db.tables.find((t) => t.id === b.to);
  if (!o || !to) return send(res, 400, { error: 'Cannot transfer' });
  if (db.orders.some((x) => x.tableId === to.id && x.status === 'open')) return send(res, 409, { error: 'Target table is busy' });
  o.tableId = to.id; to.cleaning = false; audit(user, 'table.transfer', `${params.id}->${to.id}`);
  save(); broadcast(); send(res, 200, { ok: true });
});
route('POST', '/api/tables/:id/clean', R_FLOOR, (req, res, { params }) => {
  const t = db.tables.find((x) => x.id === params.id); if (t) t.cleaning = false;
  save(); broadcast(); send(res, 200, { ok: true });
});

// ---- menu (admin; kitchen may toggle stock)
route('POST', '/api/menu', R_ADMIN, (req, res, { b, user }) => {
  const price = +b.price;
  if (!b.name || !(price >= 0) || !db.categories.find((c) => c.id === b.categoryId)) return send(res, 400, { error: 'Name, price and category are required' });
  let m = b.id && db.menu.find((x) => x.id === b.id);
  if (!m) { m = { id: uid('m'), available: true }; db.menu.push(m); }
  Object.assign(m, { name: String(b.name).slice(0, 80), price, categoryId: b.categoryId, diet: ['veg', 'nonveg', 'egg'].includes(b.diet) ? b.diet : 'veg', desc: (b.desc || '').slice(0, 200) });
  audit(user, 'menu.save', m.name); save(); broadcast(); send(res, 200, m);
});
route('DELETE', '/api/menu/:id', R_ADMIN, (req, res, { params, user }) => {
  db.menu = db.menu.filter((m) => m.id !== params.id); audit(user, 'menu.delete', params.id); save(); broadcast(); send(res, 200, { ok: true });
});
route('POST', '/api/menu/:id/available', R_KITCHEN, (req, res, { b, params, user }) => {
  const m = db.menu.find((x) => x.id === params.id); if (!m) return send(res, 404, { error: 'Not found' });
  m.available = !!b.available; audit(user, 'stock', `${m.name} ${m.available ? 'in' : 'out'}`); save(); broadcast(); send(res, 200, m);
});
route('POST', '/api/menu/import', R_ADMIN, (req, res, { b, user }) => {
  // b.csv: "category,name,price,diet" per line (CSV import from the quote)
  let n = 0;
  for (const line of String(b.csv || '').split(/\r?\n/)) {
    const [cat, name, price, diet] = line.split(',').map((s) => s && s.trim());
    if (!cat || !name || !(+price >= 0) || cat.toLowerCase() === 'category') continue;
    let c = db.categories.find((x) => x.name.toLowerCase() === cat.toLowerCase());
    if (!c) { c = { id: uid('c'), name: cat, station: 'main' }; db.categories.push(c); }
    const ex = db.menu.find((m) => m.name.toLowerCase() === name.toLowerCase() && m.categoryId === c.id);
    const d = ['veg', 'nonveg', 'egg'].includes((diet || '').toLowerCase()) ? diet.toLowerCase() : 'veg';
    if (ex) Object.assign(ex, { price: +price, diet: d }); else db.menu.push({ id: uid('m'), name, price: +price, categoryId: c.id, diet: d, available: true, desc: '' });
    n++;
  }
  audit(user, 'menu.import', n + ' rows'); save(); broadcast(); send(res, 200, { imported: n });
});
route('POST', '/api/categories', R_ADMIN, (req, res, { b }) => {
  if (!b.name) return send(res, 400, { error: 'Name required' });
  let c = b.id && db.categories.find((x) => x.id === b.id);
  if (!c) { c = { id: uid('c') }; db.categories.push(c); }
  Object.assign(c, { name: b.name, station: db.settings.stations.some((s) => s.id === b.station) ? b.station : 'main' });
  save(); broadcast(); send(res, 200, c);
});
route('DELETE', '/api/categories/:id', R_ADMIN, (req, res, { params }) => {
  if (db.menu.some((m) => m.categoryId === params.id)) return send(res, 409, { error: 'Category still has dishes' });
  db.categories = db.categories.filter((c) => c.id !== params.id); save(); broadcast(); send(res, 200, { ok: true });
});

// ---- tables, staff, settings
route('POST', '/api/tables', R_ADMIN, (req, res, { b }) => {
  if (!b.name) return send(res, 400, { error: 'Name required' });
  let t = b.id && db.tables.find((x) => x.id === b.id);
  if (!t) { let n = db.tables.length + 1; while (db.tables.some((x) => x.id === 'T' + n)) n++; t = { id: 'T' + n, cleaning: false }; db.tables.push(t); }
  Object.assign(t, { name: b.name, seats: Math.max(1, +b.seats || 4) }); save(); broadcast(); send(res, 200, t);
});
route('DELETE', '/api/tables/:id', R_ADMIN, (req, res, { params }) => {
  if (db.orders.some((o) => o.tableId === params.id && o.status === 'open')) return send(res, 409, { error: 'Table has an open order' });
  db.tables = db.tables.filter((t) => t.id !== params.id); save(); broadcast(); send(res, 200, { ok: true });
});
route('GET', '/api/staff', R_ADMIN, (req, res) => send(res, 200, db.staff));
route('POST', '/api/staff', R_ADMIN, (req, res, { b, user }) => {
  if (!b.name || !/^\d{4,6}$/.test(String(b.pin))) return send(res, 400, { error: 'Name and a 4-6 digit PIN are required' });
  if (!['admin', 'waiter', 'kitchen'].includes(b.role)) return send(res, 400, { error: 'Bad role' });
  if (db.staff.some((s) => s.pin === String(b.pin) && s.id !== b.id)) return send(res, 409, { error: 'PIN already used' });
  let s = b.id && db.staff.find((x) => x.id === b.id);
  if (!s) { s = { id: uid('s') }; db.staff.push(s); }
  Object.assign(s, { name: b.name, role: b.role, pin: String(b.pin) }); audit(user, 'staff.save', s.name); save(); send(res, 200, s);
});
route('DELETE', '/api/staff/:id', R_ADMIN, (req, res, { params, user }) => {
  const s = db.staff.find((x) => x.id === params.id);
  if (s && s.role === 'admin' && db.staff.filter((x) => x.role === 'admin').length < 2) return send(res, 409, { error: 'Keep at least one admin' });
  db.staff = db.staff.filter((x) => x.id !== params.id); audit(user, 'staff.delete', params.id); save(); send(res, 200, { ok: true });
});
route('POST', '/api/settings', R_ADMIN, (req, res, { b, user }) => {
  const s = db.settings;
  for (const k of ['name', 'address', 'phone', 'gstin', 'fssai', 'footer']) if (typeof b[k] === 'string') s[k] = b[k].slice(0, 120);
  for (const k of ['gstPercent', 'serviceChargePercent']) if (b[k] !== undefined) s[k] = Math.max(0, Math.min(40, +b[k] || 0));
  audit(user, 'settings'); save(); broadcast(); send(res, 200, s);
});

// ---- printers + print queue
route('GET', '/api/printers', R_FLOOR, (req, res) => send(res, 200, { printers: db.printers, jobs: db.printJobs.map(({ data, ...j }) => j) }));
route('POST', '/api/printers', R_ADMIN, (req, res, { b }) => {
  if (!b.name || !['kot', 'bill'].includes(b.type)) return send(res, 400, { error: 'Name and type required' });
  if (!b.id && db.printers.length >= 3) return send(res, 409, { error: 'Up to 3 printers supported' });
  let p = b.id && db.printers.find((x) => x.id === b.id);
  if (!p) { p = { id: uid('p-') }; db.printers.push(p); }
  Object.assign(p, { name: b.name, type: b.type, host: (b.host || '').trim(), port: +b.port || 9100, width: [32, 42, 48].includes(+b.width) ? +b.width : 42, stations: Array.isArray(b.stations) ? b.stations : [] });
  save(); broadcast('print'); send(res, 200, p);
});
route('DELETE', '/api/printers/:id', R_ADMIN, (req, res, { params }) => {
  db.printers = db.printers.filter((p) => p.id !== params.id); save(); broadcast('print'); send(res, 200, { ok: true });
});
route('POST', '/api/printers/:id/test', R_ADMIN, (req, res, { params }) => {
  const p = db.printers.find((x) => x.id === params.id); if (!p) return send(res, 404, { error: 'Not found' });
  const e = new Escpos(p.width);
  e.align('center').bold(true).size(2, 2).line('TEST PRINT').size(1, 1).bold(false).line(db.settings.name).line(p.name + ' (' + p.type.toUpperCase() + ')')
    .line(p.host ? `${p.host}:${p.port}` : 'Virtual printer').hr().line(when(Date.now())).line('0123456789'.repeat(5).slice(0, p.width)).feed(1).cut();
  enqueue(p.id, 'Test print', e.buffer()); send(res, 200, { ok: true });
});
route('POST', '/api/print/jobs/:id/retry', R_FLOOR, (req, res, { params }) => {
  const j = db.printJobs.find((x) => x.id === params.id); if (!j) return send(res, 404, { error: 'Not found' });
  j.attempts = 0; j.status = 'queued'; runJob(j); send(res, 200, { ok: true });
});
route('GET', '/api/orders/:id/receipt', R_ALL, (req, res, { params }) => {
  const o = db.orders.find((x) => x.id === params.id); if (!o) return send(res, 404, { error: 'Not found' });
  if (!o.billNo) { o.billNo = ++db.counters.bill; save(); }
  send(res, 200, { text: Escpos.toText(buildBill(o, 42)) });
});

// ---- reports
route('GET', '/api/reports', R_ADMIN, (req, res) => {
  const day = new Date(); day.setHours(0, 0, 0, 0);
  const from = req.query.range === 'all' ? 0 : req.query.range === 'week' ? day.getTime() - 6 * 864e5 : day.getTime();
  const paid = db.orders.filter((o) => o.status === 'paid' && o.closedAt >= from);
  const byPay = {}, byCat = {}, byItem = {}, byHour = Array(24).fill(0), byWaiter = {};
  let gross = 0, tax = 0, discounts = 0, prep = [];
  for (const o of paid) {
    const t = orderTotals(o); gross += t.total; tax += t.gst; discounts += t.discount;
    byPay[o.payment.method] = (byPay[o.payment.method] || 0) + t.total;
    byHour[new Date(o.closedAt).getHours()] += t.total;
    byWaiter[o.waiter] = (byWaiter[o.waiter] || 0) + t.total;
    for (const i of o.items) {
      if (i.status === 'void') continue;
      const c = (db.categories.find((x) => x.id === (db.menu.find((m) => m.id === i.menuId) || {}).categoryId) || { name: 'Other' }).name;
      byCat[c] = (byCat[c] || 0) + i.price * i.qty;
      const e = (byItem[i.name] = byItem[i.name] || { qty: 0, amt: 0 }); e.qty += i.qty; e.amt += i.price * i.qty;
      if (i.readyAt && i.sentAt) prep.push(i.readyAt - i.sentAt);
    }
  }
  send(res, 200, {
    orders: paid.length, gross, tax, discounts, avgBill: paid.length ? Math.round(gross / paid.length) : 0,
    avgPrepMin: prep.length ? Math.round(prep.reduce((a, b) => a + b, 0) / prep.length / 6000) / 10 : 0,
    byPay, byCat, byHour, byWaiter,
    top: Object.entries(byItem).sort((a, b) => b[1].qty - a[1].qty).slice(0, 10).map(([name, v]) => ({ name, ...v })),
    audit: db.audit.slice(0, 50),
  });
});

// ---------- HTTP server ----------
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  req.query = Object.fromEntries(url.searchParams);
  try {
    if (url.pathname === '/api/stream') {
      const u = sessions.get(req.query.token); if (!u) return send(res, 401, { error: 'auth' });
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write('retry: 2000\n\n'); clients.add(res); req.on('close', () => clients.delete(res)); return;
    }
    if (url.pathname.startsWith('/api/')) {
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = url.pathname.match(r.re); if (!m) continue;
        let user = null;
        if (r.roles) {
          user = sessions.get(req.headers['x-token']);
          if (!user) return send(res, 401, { error: 'Please sign in again' });
          if (!r.roles.includes(user.role)) return send(res, 403, { error: 'Not allowed for your role' });
        }
        const b = req.method === 'POST' ? await body(req) : {};
        return r.fn(req, res, { b, params: m.groups || {}, user });
      }
      return send(res, 404, { error: 'Not found' });
    }
    // static files
    let f = url.pathname === '/' ? '/index.html' : url.pathname;
    f = path.normalize(path.join(__dirname, 'public', f));
    if (!f.startsWith(path.join(__dirname, 'public'))) return send(res, 403, 'Forbidden', 'text/plain');
    fs.readFile(f, (err, data) => {
      if (err) return send(res, 404, 'Not found', 'text/plain');
      res.writeHead(200, { 'Content-Type': (MIME[path.extname(f)] || 'application/octet-stream') + '; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  } catch (e) {
    console.error(e); send(res, 500, { error: 'Server error' });
  }
});
server.listen(PORT, '0.0.0.0', () => {
  const ips = Object.values(require('os').networkInterfaces()).flat().filter((i) => i.family === 'IPv4' && !i.internal).map((i) => i.address);
  console.log(`Flavours Kitchen running:\n  http://localhost:${PORT}` + ips.map((a) => `\n  http://${a}:${PORT}   (use this on tablets/phones on the same Wi-Fi)`).join(''));
  console.log('Default PINs -> admin 1111, waiter 2222, kitchen 3333 (change in Admin > Staff)');
});
process.on('SIGINT', () => { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 1)); process.exit(0); });
