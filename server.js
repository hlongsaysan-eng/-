'use strict';
// ระบบใบเสนอราคา — เซิร์ฟเวอร์สำหรับใช้งานบนเครื่องเดียว (ไม่ต้องติดตั้งแพ็กเกจเพิ่ม)
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile, spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const Calc = require('./lib/calc');
const { renderPrint } = require('./lib/print');

const PORT = Number(process.env.PORT) || 3900;
const HOST = '127.0.0.1';
const DATA = process.env.QT_DATA_DIR || path.join(__dirname, 'data');
const PDF_DIR = path.join(DATA, 'pdf');
const PUBLIC = path.join(__dirname, 'public');
fs.mkdirSync(PDF_DIR, { recursive: true });

// ---------- ฐานข้อมูล ----------
const db = new DatabaseSync(path.join(DATA, 'quotation.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL,
    pass_hash TEXT NOT NULL, salt TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE IF NOT EXISTS counters (key TEXT PRIMARY KEY, n INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY, code TEXT, name TEXT NOT NULL, tax_id TEXT, branch TEXT, address TEXT,
    contact TEXT, phone TEXT, email TEXT, line_id TEXT, note TEXT, active INTEGER NOT NULL DEFAULT 1);
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY, code TEXT, name TEXT NOT NULL, description TEXT, unit TEXT,
    price REAL NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1);
  CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY, type TEXT NOT NULL, number TEXT UNIQUE NOT NULL, date TEXT NOT NULL, valid_until TEXT,
    customer_id INTEGER NOT NULL, customer_json TEXT NOT NULL, subject TEXT, items_json TEXT NOT NULL,
    vat_mode TEXT NOT NULL, vat_rate REAL NOT NULL, discount_type TEXT NOT NULL, discount_value REAL NOT NULL, wht_rate REAL NOT NULL,
    subtotal REAL NOT NULL, discount_amount REAL NOT NULL, net REAL NOT NULL, vat_amount REAL NOT NULL, total REAL NOT NULL, wht_amount REAL NOT NULL,
    status TEXT NOT NULL, note TEXT, terms TEXT, owner_id INTEGER NOT NULL, approver_id INTEGER, approved_at TEXT,
    source_id INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS doc_log (
    id INTEGER PRIMARY KEY, doc_id INTEGER NOT NULL, user_id INTEGER, action TEXT NOT NULL, note TEXT, at TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS idx_documents_type ON documents(type, date);
`);

const all = (sql, ...p) => db.prepare(sql).all(...p);
const get = (sql, ...p) => db.prepare(sql).get(...p);
const run = (sql, ...p) => db.prepare(sql).run(...p);
function insert(table, obj) {
  const k = Object.keys(obj);
  return Number(run(`INSERT INTO ${table} (${k.join(',')}) VALUES (${k.map(() => '?').join(',')})`, ...k.map(x => obj[x])).lastInsertRowid);
}
function update(table, id, obj) {
  const k = Object.keys(obj);
  run(`UPDATE ${table} SET ${k.map(x => `${x}=?`).join(',')} WHERE id=?`, ...k.map(x => obj[x]), id);
}

// ---------- ตัวช่วย ----------
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const pad = n => String(n).padStart(2, '0');
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
const now = () => new Date().toISOString();
const str = (v, max = 500) => String(v ?? '').trim().slice(0, max);
const isoDate = v => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : '');
const clamp = (v, lo, hi) => Math.min(Math.max(Calc.num(v), lo), hi);

const SETTING_DEFAULTS = {
  company_name: '', company_address: '', company_tax_id: '', company_branch: 'สำนักงานใหญ่',
  company_phone: '', company_email: '', logo: '', brand_color: '#1e3a8a',
  default_valid_days: '30', default_vat_mode: 'exclusive', vat_rate: '7', approval_min: '0',
  default_terms: 'ชำระเงินภายใน 30 วันนับจากวันที่ส่งมอบ',
  line_template: 'เรียน {contact}\n{company} ขอส่งใบเสนอราคาเลขที่ {number} {subject}\nยอดรวมทั้งสิ้น {total} บาท ยืนราคาถึงวันที่ {valid_until}\nรายละเอียดตามไฟล์แนบ หากมีข้อสงสัยสอบถามได้เลยครับ/ค่ะ\n{sender}',
};
function getSettings() {
  const s = { ...SETTING_DEFAULTS };
  for (const r of all('SELECT key, value FROM settings')) if (r.key in s) s[r.key] = r.value;
  return s;
}
function saveSettings(obj) {
  for (const k of Object.keys(SETTING_DEFAULTS)) {
    if (obj[k] === undefined) continue;
    const max = k === 'logo' ? 1500000 : 2000;
    run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', k, String(obj[k]).slice(0, max));
  }
}

// ---------- ผู้ใช้และการเข้าสู่ระบบ ----------
const ROLES = ['admin', 'approver', 'sales'];
const hashPassword = (password, salt) => crypto.scryptSync(password, salt, 32).toString('hex');
function newPassword(password) {
  if (typeof password !== 'string' || password.length < 6) throw new HttpError(400, 'รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร');
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, pass_hash: hashPassword(password, salt) };
}
function checkPassword(user, password) {
  const a = Buffer.from(hashPassword(String(password ?? ''), user.salt), 'hex');
  return crypto.timingSafeEqual(a, Buffer.from(user.pass_hash, 'hex'));
}
const publicUser = u => u && { id: u.id, username: u.username, name: u.name, role: u.role, active: u.active };

function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const maxAge = 7 * 24 * 3600;
  run('DELETE FROM sessions WHERE expires < ?', Date.now());
  run('INSERT INTO sessions (token, user_id, expires) VALUES (?, ?, ?)', token, userId, Date.now() + maxAge * 1000);
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`);
}
function sessionToken(req) {
  const m = /(?:^|;\s*)sid=([a-f0-9]{64})/.exec(req.headers.cookie || '');
  return m && m[1];
}
function currentUser(req) {
  const token = sessionToken(req);
  if (!token) return null;
  const u = get('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token=? AND s.expires>? AND u.active=1', token, Date.now());
  return u || null;
}

// ---------- เอกสาร ----------
const DOC_TYPES = ['QT', 'SO', 'IV'];
const DOC_SELECT = `SELECT d.*, o.name AS owner_name, a.name AS approver_name, s.number AS source_number
  FROM documents d LEFT JOIN users o ON o.id = d.owner_id LEFT JOIN users a ON a.id = d.approver_id
  LEFT JOIN documents s ON s.id = d.source_id`;

function present(d, full) {
  const out = { ...d };
  out.customer = JSON.parse(d.customer_json);
  if (full) out.items = JSON.parse(d.items_json);
  delete out.customer_json;
  delete out.items_json;
  const expired = d.type === 'QT' && ['approved', 'sent'].includes(d.status) && d.valid_until && d.valid_until < today();
  out.display_status = expired ? 'expired' : d.status;
  return out;
}
function loadDoc(id) {
  const d = get(`${DOC_SELECT} WHERE d.id=?`, Number(id));
  if (!d) throw new HttpError(404, 'ไม่พบเอกสาร');
  return present(d, true);
}
function nextNumber(type, date) {
  const key = `${type}${date.slice(0, 4)}${date.slice(5, 7)}`;
  run('INSERT INTO counters (key, n) VALUES (?, 1) ON CONFLICT(key) DO UPDATE SET n = n + 1', key);
  return `${key}-${String(get('SELECT n FROM counters WHERE key=?', key).n).padStart(4, '0')}`;
}
function logDoc(docId, user, action, note = '') {
  insert('doc_log', { doc_id: docId, user_id: user ? user.id : null, action, note: str(note, 1000), at: now() });
}
const canManage = (user, doc) => user.role !== 'sales' || doc.owner_id === user.id;
const canApprove = user => user.role === 'admin' || user.role === 'approver';

function docInput(b) {
  const customer = get('SELECT * FROM customers WHERE id=?', Number(b.customer_id));
  if (!customer) throw new HttpError(400, 'กรุณาเลือกลูกค้า');
  const items = (Array.isArray(b.items) ? b.items : []).map(it => ({
    name: str(it.name, 300), description: str(it.description, 1000), unit: str(it.unit, 30),
    qty: Math.max(Calc.num(it.qty), 0), price: Math.max(Calc.num(it.price), 0), discount: clamp(it.discount, 0, 100),
  })).filter(it => it.name);
  if (!items.length) throw new HttpError(400, 'กรุณาเพิ่มรายการสินค้าอย่างน้อย 1 รายการ');
  const f = {
    date: isoDate(b.date) || today(),
    valid_until: isoDate(b.valid_until),
    subject: str(b.subject, 300),
    vat_mode: ['exclusive', 'inclusive', 'none'].includes(b.vat_mode) ? b.vat_mode : 'exclusive',
    vat_rate: clamp(b.vat_rate, 0, 100),
    discount_type: b.discount_type === 'percent' ? 'percent' : 'amount',
    discount_value: Math.max(Calc.num(b.discount_value), 0),
    wht_rate: clamp(b.wht_rate, 0, 100),
    note: str(b.note, 2000),
    terms: str(b.terms, 2000),
  };
  const { payable, ...t } = Calc.totals({ ...f, items });
  const { id, active, ...snapshot } = customer;
  return { ...f, ...t, customer_id: customer.id, customer_json: JSON.stringify(snapshot), items_json: JSON.stringify(items) };
}

// สถานะที่เปลี่ยนได้: from = สถานะก่อนหน้า, to = สถานะใหม่, approver = ต้องเป็นผู้อนุมัติ
const ACTIONS = {
  QT: {
    submit: { from: ['draft', 'returned'], to: 'pending' },
    approve: { from: ['pending'], to: 'approved', approver: true },
    return: { from: ['pending'], to: 'returned', approver: true },
    revise: { from: ['pending', 'approved', 'sent', 'declined'], to: 'draft' },
    send: { from: ['approved'], to: 'sent' },
    accept: { from: ['approved', 'sent'], to: 'accepted' },
    decline: { from: ['approved', 'sent'], to: 'declined' },
    cancel: { from: ['draft', 'returned', 'pending', 'approved', 'sent', 'accepted', 'declined'], to: 'cancelled' },
  },
  SO: { cancel: { from: ['open'], to: 'cancelled' } },
  IV: { paid: { from: ['open'], to: 'paid' }, cancel: { from: ['open', 'paid'], to: 'cancelled' } },
};
const EDITABLE = ['draft', 'returned', 'open'];

function doAction(user, doc, action, note) {
  const rule = ACTIONS[doc.type][action];
  if (!rule || !rule.from.includes(doc.status)) throw new HttpError(400, 'ไม่สามารถทำรายการนี้กับสถานะปัจจุบันได้');
  if (rule.approver ? !canApprove(user) : !canManage(user, doc)) throw new HttpError(403, 'คุณไม่มีสิทธิ์ทำรายการนี้');
  const set = { status: rule.to, updated_at: now() };
  let logged = action;
  if (action === 'submit' && doc.total < Calc.num(getSettings().approval_min)) {
    // ยอดต่ำกว่าเกณฑ์ที่ตั้งไว้ ไม่ต้องรออนุมัติ
    Object.assign(set, { status: 'approved', approver_id: null, approved_at: now() });
    logged = 'auto_approve';
  }
  if (action === 'approve') Object.assign(set, { approver_id: user.id, approved_at: now() });
  if (action === 'revise' || action === 'return') Object.assign(set, { approver_id: null, approved_at: null });
  update('documents', doc.id, set);
  logDoc(doc.id, user, logged, note);
}

function convertDoc(user, src, type) {
  const allowed = (src.type === 'QT' && src.status === 'accepted' && ['SO', 'IV'].includes(type))
    || (src.type === 'SO' && src.status === 'open' && type === 'IV');
  if (!allowed) throw new HttpError(400, 'เอกสารนี้ยังไม่สามารถแปลงเป็นเอกสารประเภทดังกล่าวได้');
  if (!canManage(user, src)) throw new HttpError(403, 'คุณไม่มีสิทธิ์ทำรายการนี้');
  const dup = get("SELECT number FROM documents WHERE source_id=? AND type=? AND status<>'cancelled'", src.id, type);
  if (dup) throw new HttpError(400, `มีเอกสาร ${dup.number} ที่สร้างจากใบนี้อยู่แล้ว`);
  const raw = get('SELECT * FROM documents WHERE id=?', src.id);
  const date = today();
  const due = new Date();
  due.setDate(due.getDate() + 30);
  const { id, number, approver_id, approved_at, ...copy } = raw;
  const newId = insert('documents', {
    ...copy, type, number: nextNumber(type, date), date,
    valid_until: type === 'IV' ? `${due.getFullYear()}-${pad(due.getMonth() + 1)}-${pad(due.getDate())}` : '',
    status: 'open', owner_id: user.id, source_id: src.id, created_at: now(), updated_at: now(),
  });
  logDoc(newId, user, 'create', `สร้างจาก ${src.number}`);
  logDoc(src.id, user, 'convert', get('SELECT number FROM documents WHERE id=?', newId).number);
  return newId;
}

// ---------- PDF (ใช้ Edge/Chrome ที่มีในเครื่อง) ----------
const printTokens = new Map();
function findBrowser() {
  const pf = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
  const rel = ['Microsoft\\Edge\\Application\\msedge.exe', 'Google\\Chrome\\Application\\chrome.exe'];
  for (const r of rel) for (const p of pf) if (fs.existsSync(path.join(p, r))) return path.join(p, r);
  return null;
}
const pdfPath = doc => path.join(PDF_DIR, `${doc.number}.pdf`);
function makePdf(doc) {
  const exe = findBrowser();
  if (!exe) throw new HttpError(500, 'ไม่พบ Microsoft Edge หรือ Google Chrome สำหรับสร้างไฟล์ PDF');
  const file = pdfPath(doc);
  try {
    fs.rmSync(file, { force: true });
  } catch {
    throw new HttpError(409, 'ไฟล์ PDF เดิมถูกเปิดค้างอยู่ กรุณาปิดไฟล์แล้วลองใหม่');
  }
  const token = crypto.randomBytes(16).toString('hex');
  printTokens.set(token, Date.now() + 60000);
  const args = ['--headless', '--disable-gpu', '--no-pdf-header-footer', `--user-data-dir=${path.join(DATA, 'browser-profile')}`,
    `--print-to-pdf=${file}`, `http://${HOST}:${PORT}/print/${doc.id}?embed=1&token=${token}`];
  return new Promise((resolve, reject) => {
    execFile(exe, args, { timeout: 45000 }, () => {
      printTokens.delete(token);
      if (fs.existsSync(file)) resolve(file);
      else reject(new HttpError(500, 'สร้างไฟล์ PDF ไม่สำเร็จ'));
    });
  });
}

// ---------- เส้นทาง API ----------
const routes = [];
function route(method, pattern, handler, opts = {}) {
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$');
  routes.push({ method, re, handler, ...opts });
}
const adminOnly = { roles: ['admin'] };

route('GET', '/api/state', ({ user }) => {
  const s = getSettings();
  return {
    setup: get('SELECT COUNT(*) AS n FROM users').n === 0,
    user: publicUser(user),
    company_name: s.company_name,
    settings: user ? s : null,
    today: today(),
  };
}, { public: true });

route('POST', '/api/setup', ({ body, res }) => {
  if (get('SELECT COUNT(*) AS n FROM users').n > 0) throw new HttpError(400, 'ตั้งค่าระบบไปแล้ว');
  const username = str(body.username, 50).toLowerCase();
  if (!username || !str(body.name)) throw new HttpError(400, 'กรุณากรอกข้อมูลให้ครบ');
  const id = insert('users', { username, name: str(body.name, 100), role: 'admin', ...newPassword(body.password), created_at: now() });
  saveSettings({ company_name: str(body.company_name, 200) });
  createSession(res, id);
  return { ok: true };
}, { public: true });

route('POST', '/api/login', ({ body, res }) => {
  const u = get('SELECT * FROM users WHERE username=? AND active=1', str(body.username, 50).toLowerCase());
  if (!u || !checkPassword(u, body.password)) throw new HttpError(401, 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
  createSession(res, u.id);
  return { ok: true };
}, { public: true });

route('POST', '/api/logout', ({ req, res }) => {
  const token = sessionToken(req);
  if (token) run('DELETE FROM sessions WHERE token=?', token);
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  return { ok: true };
}, { public: true });

route('PUT', '/api/me/password', ({ user, body }) => {
  if (!checkPassword(user, body.current)) throw new HttpError(400, 'รหัสผ่านปัจจุบันไม่ถูกต้อง');
  update('users', user.id, newPassword(body.password));
  return { ok: true };
});

route('PUT', '/api/settings', ({ body }) => {
  saveSettings(body);
  return getSettings();
}, adminOnly);

route('GET', '/api/users', () => all('SELECT * FROM users ORDER BY id').map(publicUser), adminOnly);
route('POST', '/api/users', ({ body }) => {
  const username = str(body.username, 50).toLowerCase();
  if (!username || !str(body.name)) throw new HttpError(400, 'กรุณากรอกข้อมูลให้ครบ');
  if (get('SELECT 1 AS x FROM users WHERE username=?', username)) throw new HttpError(400, 'ชื่อผู้ใช้นี้ถูกใช้แล้ว');
  const role = ROLES.includes(body.role) ? body.role : 'sales';
  return { id: insert('users', { username, name: str(body.name, 100), role, ...newPassword(body.password), created_at: now() }) };
}, adminOnly);
route('PUT', '/api/users/:id', ({ params, body }) => {
  const u = get('SELECT * FROM users WHERE id=?', Number(params.id));
  if (!u) throw new HttpError(404, 'ไม่พบผู้ใช้');
  const set = {
    name: str(body.name, 100) || u.name,
    role: ROLES.includes(body.role) ? body.role : u.role,
    active: body.active === undefined ? u.active : (body.active ? 1 : 0),
  };
  if (u.role === 'admin' && u.active && (set.role !== 'admin' || !set.active)
    && get("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND active=1").n <= 1) {
    throw new HttpError(400, 'ต้องมีผู้ดูแลระบบที่ใช้งานได้อย่างน้อย 1 คน');
  }
  if (body.password) Object.assign(set, newPassword(body.password));
  update('users', u.id, set);
  if (!set.active) run('DELETE FROM sessions WHERE user_id=?', u.id);
  return { ok: true };
}, adminOnly);

// ลูกค้า / สินค้า ใช้โครงเดียวกัน
function crud(table, fields, numeric = []) {
  const clean = body => {
    const o = {};
    for (const f of fields) o[f] = numeric.includes(f) ? Math.max(Calc.num(body[f]), 0) : str(body[f], 1000);
    if (!o.name) throw new HttpError(400, 'กรุณากรอกชื่อ');
    return o;
  };
  route('GET', `/api/${table}`, () => all(`SELECT * FROM ${table} WHERE active=1 ORDER BY name`));
  route('POST', `/api/${table}`, ({ body }) => get(`SELECT * FROM ${table} WHERE id=?`, insert(table, clean(body))));
  route('PUT', `/api/${table}/:id`, ({ params, body }) => {
    update(table, Number(params.id), clean(body));
    return get(`SELECT * FROM ${table} WHERE id=?`, Number(params.id));
  });
  route('DELETE', `/api/${table}/:id`, ({ params }) => {
    update(table, Number(params.id), { active: 0 });
    return { ok: true };
  });
}
crud('customers', ['code', 'name', 'tax_id', 'branch', 'address', 'contact', 'phone', 'email', 'line_id', 'note']);
crud('products', ['code', 'name', 'description', 'unit', 'price'], ['price']);

route('GET', '/api/docs', ({ query }) => {
  const type = DOC_TYPES.includes(query.get('type')) ? query.get('type') : 'QT';
  return all(`${DOC_SELECT} WHERE d.type=? ORDER BY d.date DESC, d.id DESC`, type).map(d => present(d, false));
});
route('GET', '/api/docs/:id', ({ params }) => {
  const doc = loadDoc(params.id);
  doc.log = all('SELECT l.action, l.note, l.at, u.name AS user_name FROM doc_log l LEFT JOIN users u ON u.id=l.user_id WHERE l.doc_id=? ORDER BY l.id', doc.id);
  doc.children = all("SELECT id, type, number, status FROM documents WHERE source_id=? AND status<>'cancelled'", doc.id);
  return doc;
});
route('POST', '/api/docs', ({ user, body }) => {
  const f = docInput(body);
  const id = insert('documents', {
    ...f, type: 'QT', number: nextNumber('QT', f.date), status: 'draft', owner_id: user.id, created_at: now(), updated_at: now(),
  });
  logDoc(id, user, 'create');
  return { id };
});
route('PUT', '/api/docs/:id', ({ user, params, body }) => {
  const doc = loadDoc(params.id);
  if (!EDITABLE.includes(doc.status)) throw new HttpError(400, 'เอกสารสถานะนี้แก้ไขไม่ได้ กรุณาดึงกลับมาแก้ไขก่อน');
  if (!canManage(user, doc)) throw new HttpError(403, 'คุณไม่มีสิทธิ์แก้ไขเอกสารนี้');
  update('documents', doc.id, { ...docInput(body), updated_at: now() });
  logDoc(doc.id, user, 'update');
  return { id: doc.id };
});
route('POST', '/api/docs/:id/action', ({ user, params, body }) => {
  doAction(user, loadDoc(params.id), str(body.action, 20), body.note);
  return { ok: true };
});
route('POST', '/api/docs/:id/convert', ({ user, params, body }) => ({ id: convertDoc(user, loadDoc(params.id), body.type) }));
route('POST', '/api/docs/:id/pdf', async ({ params }) => {
  const doc = loadDoc(params.id);
  await makePdf(doc);
  return { url: `/files/pdf/${doc.number}.pdf`, name: `${doc.number}.pdf` };
});
route('POST', '/api/docs/:id/reveal', ({ params }) => {
  const file = pdfPath(loadDoc(params.id));
  if (!fs.existsSync(file)) throw new HttpError(404, 'ยังไม่ได้สร้างไฟล์ PDF');
  spawn('explorer.exe', ['/select,', file], { detached: true, stdio: 'ignore' }).unref();
  return { ok: true };
});

route('GET', '/files/pdf/:name', ({ params, res }) => {
  const name = decodeURIComponent(params.name);
  if (!/^[A-Z0-9-]+\.pdf$/.test(name) || !fs.existsSync(path.join(PDF_DIR, name))) throw new HttpError(404, 'ไม่พบไฟล์');
  res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${name}"` });
  fs.createReadStream(path.join(PDF_DIR, name)).pipe(res);
});

route('GET', '/api/backup', ({ res }) => {
  const stamp = now().replace(/[-:]/g, '').slice(0, 15);
  const file = path.join(DATA, `backup-${stamp}.db`);
  run('VACUUM INTO ?', file);
  res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="quotation-backup-${stamp}.db"` });
  fs.createReadStream(file).on('close', () => fs.rm(file, { force: true }, () => {})).pipe(res);
}, adminOnly);

route('GET', '/print/:id', ({ params, query, res }) => {
  const html = renderPrint(loadDoc(params.id), getSettings(), { embed: query.has('embed') });
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}, { printToken: true });

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
function serveStatic(pathname, res) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = rel === 'lib/calc.js' ? path.join(__dirname, rel) : path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep) && rel !== 'lib/calc.js') return false;
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
  return true;
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > 4 * 1024 * 1024) {
        reject(new HttpError(413, 'ข้อมูลมีขนาดใหญ่เกินไป'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'รูปแบบข้อมูลไม่ถูกต้อง'));
      }
    });
    req.on('error', reject);
  });
}
function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  try {
    // รับเฉพาะคำขอที่เรียกมาที่เครื่องนี้โดยตรง
    if (!['localhost', '127.0.0.1'].includes((req.headers.host || '').split(':')[0])) throw new HttpError(403, 'Forbidden');
    const url = new URL(req.url, `http://${HOST}:${PORT}`);
    for (const r of routes) {
      const m = r.method === req.method && r.re.exec(url.pathname);
      if (!m) continue;
      const user = currentUser(req);
      const token = url.searchParams.get('token');
      const tokenOk = r.printToken && token && printTokens.get(token) > Date.now();
      if (!r.public && !user && !tokenOk) throw new HttpError(401, 'กรุณาเข้าสู่ระบบ');
      if (r.roles && !r.roles.includes(user.role)) throw new HttpError(403, 'เฉพาะผู้ดูแลระบบเท่านั้น');
      const body = ['POST', 'PUT'].includes(req.method) ? await readBody(req) : {};
      const result = await r.handler({ req, res, user, body, params: m.groups || {}, query: url.searchParams });
      if (result !== undefined) sendJson(res, 200, result);
      return;
    }
    if (req.method === 'GET' && serveStatic(decodeURIComponent(url.pathname), res)) return;
    throw new HttpError(404, 'ไม่พบหน้าที่ต้องการ');
  } catch (err) {
    if (!err.status) console.error(err);
    if (!res.headersSent) sendJson(res, err.status || 500, { error: err.status ? err.message : 'เกิดข้อผิดพลาดในระบบ' });
    else res.end();
  }
});

const appUrl = `http://localhost:${PORT}`;
const openBrowser = () => process.argv.includes('--open') && spawn('cmd', ['/c', 'start', '', appUrl], { detached: true, stdio: 'ignore' }).unref();
server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.log(`ระบบเปิดใช้งานอยู่แล้วที่ ${appUrl}`);
    openBrowser();
    process.exit(0);
  }
  throw err;
});
server.listen(PORT, HOST, () => {
  console.log(`ระบบใบเสนอราคาพร้อมใช้งานที่ ${appUrl}`);
  console.log('ปิดหน้าต่างนี้เมื่อต้องการหยุดระบบ');
  openBrowser();
});
