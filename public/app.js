'use strict';
/* global Calc */
const { money, thDate } = Calc;
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let S = {}; // สถานะจากเซิร์ฟเวอร์: user, settings, today
let view;   // <main>

const TYPES = { QT: 'ใบเสนอราคา', SO: 'ใบสั่งขาย', IV: 'ใบแจ้งหนี้' };
const DUE_LABEL = { QT: 'ยืนราคาถึง', SO: 'กำหนดส่งมอบ', IV: 'ครบกำหนดชำระ' };
const ROLES = { admin: 'ผู้ดูแลระบบ', approver: 'ผู้อนุมัติ', sales: 'พนักงานขาย' };
const STATUS = {
  draft: ['ร่าง', 'gray'], pending: ['รออนุมัติ', 'amber'], returned: ['ส่งกลับแก้ไข', 'red'],
  approved: ['อนุมัติแล้ว', 'blue'], sent: ['ส่งลูกค้าแล้ว', 'indigo'], accepted: ['ลูกค้าตอบรับ', 'green'],
  declined: ['ลูกค้าปฏิเสธ', 'red'], expired: ['หมดอายุ', 'gray'], cancelled: ['ยกเลิก', 'gray'],
  open: ['ออกเอกสารแล้ว', 'blue'], paid: ['ชำระแล้ว', 'green'],
};
const LOG = {
  create: 'สร้างเอกสาร', update: 'แก้ไขเอกสาร', submit: 'ส่งขออนุมัติ', auto_approve: 'อนุมัติอัตโนมัติ (ยอดต่ำกว่าเกณฑ์)',
  approve: 'อนุมัติ', return: 'ส่งกลับแก้ไข', revise: 'ดึงกลับมาแก้ไข', send: 'ส่งให้ลูกค้าแล้ว', accept: 'ลูกค้าตอบรับ',
  decline: 'ลูกค้าปฏิเสธ', cancel: 'ยกเลิกเอกสาร', paid: 'บันทึกรับชำระ', convert: 'สร้างเอกสารต่อเนื่อง',
};
const MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];

const badge = st => `<span class="badge ${STATUS[st][1]}">${STATUS[st][0]}</span>`;
const sum = (arr, f) => arr.reduce((s, x) => s + f(x), 0);

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && S.user) location.reload();
  if (!res.ok) throw new Error(data.error || 'เกิดข้อผิดพลาด');
  return data;
}

function toast(msg, isError) {
  const el = document.createElement('div');
  el.textContent = msg;
  if (isError) el.className = 'err';
  $('#toast').append(el);
  setTimeout(() => el.remove(), isError ? 5000 : 2500);
}
// ครอบ handler ให้แสดงข้อผิดพลาดเป็น toast
const safe = fn => async (...a) => {
  try {
    return await fn(...a);
  } catch (err) {
    toast(err.message, true);
  }
};

function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function modal({ title, body, ok = 'บันทึก', onOk, wide }) {
  const el = document.createElement('div');
  el.className = 'modal-bg';
  el.innerHTML = `<form class="modal ${wide ? 'wide' : ''}"><h3>${esc(title)}</h3><div class="modal-body">${body}</div>
    <div class="modal-foot"><button type="button" class="btn" data-close>ปิด</button>${onOk ? `<button class="btn primary">${esc(ok)}</button>` : ''}</div></form>`;
  document.body.append(el);
  $('[data-close]', el).onclick = () => el.remove();
  $('form', el).onsubmit = safe(async e => {
    e.preventDefault();
    if (onOk && await onOk(new FormData(e.target)) !== false) el.remove();
  });
  const first = $('input, textarea, select', el);
  if (first) first.focus();
  return el;
}

// ---------- เริ่มต้น / เข้าสู่ระบบ ----------
async function boot() {
  S = await api('GET', '/api/state');
  if (S.setup) return renderSetup();
  if (!S.user) return renderLogin();
  renderShell();
  route();
}

function renderSetup() {
  $('#app').innerHTML = `<div class="center"><form class="card">
    <div><h1>ตั้งค่าระบบครั้งแรก</h1><p class="muted">สร้างบัญชีผู้ดูแลระบบสำหรับเริ่มใช้งาน</p></div>
    <div><label>ชื่อบริษัท / องค์กร</label><input name="company_name" required></div>
    <div><label>ชื่อ-นามสกุลของคุณ</label><input name="name" required></div>
    <div><label>ชื่อผู้ใช้ (สำหรับเข้าสู่ระบบ)</label><input name="username" required autocomplete="username"></div>
    <div><label>รหัสผ่าน (อย่างน้อย 6 ตัวอักษร)</label><input name="password" type="password" minlength="6" required autocomplete="new-password"></div>
    <button class="btn primary" style="width:100%">เริ่มใช้งาน</button>
  </form></div>`;
  $('form').onsubmit = safe(async e => {
    e.preventDefault();
    await api('POST', '/api/setup', Object.fromEntries(new FormData(e.target)));
    location.hash = '#/settings';
    await boot();
  });
}

function renderLogin() {
  $('#app').innerHTML = `<div class="center"><form class="card">
    <div><h1>ระบบใบเสนอราคา</h1><p class="muted">${esc(S.company_name)}</p></div>
    <div><label>ชื่อผู้ใช้</label><input name="username" required autocomplete="username" autofocus></div>
    <div><label>รหัสผ่าน</label><input name="password" type="password" required autocomplete="current-password"></div>
    <button class="btn primary" style="width:100%">เข้าสู่ระบบ</button>
  </form></div>`;
  $('form').onsubmit = safe(async e => {
    e.preventDefault();
    await api('POST', '/api/login', Object.fromEntries(new FormData(e.target)));
    await boot();
  });
}

function renderShell() {
  const link = (path, label) => `<a href="#${path}" data-nav="${path}">${label}</a>`;
  $('#app').innerHTML = `<div class="shell">
    <aside class="side">
      <div class="brand">${esc(S.settings.company_name || 'ระบบใบเสนอราคา')}</div>
      <nav>
        ${link('/', 'ภาพรวม')}
        <div class="sep">เอกสาร</div>
        ${link('/docs/QT', 'ใบเสนอราคา')}${link('/docs/SO', 'ใบสั่งขาย')}${link('/docs/IV', 'ใบแจ้งหนี้')}
        <div class="sep">ข้อมูลหลัก</div>
        ${link('/customers', 'ลูกค้า')}${link('/products', 'สินค้า / บริการ')}
        <div class="sep">อื่น ๆ</div>
        ${link('/reports', 'รายงาน')}${link('/settings', 'ตั้งค่า')}
      </nav>
      <div class="me">${esc(S.user.name)}<br><span class="muted">${ROLES[S.user.role]}</span><br><button class="btn sm" id="logout">ออกจากระบบ</button></div>
    </aside>
    <main id="view"></main>
  </div>`;
  view = $('#view');
  $('#logout').onclick = safe(async () => {
    await api('POST', '/api/logout');
    location.hash = '';
    location.reload();
  });
}

const ROUTES = [
  [/^\/$/, dashboard],
  [/^\/docs\/(QT|SO|IV)$/, docList],
  [/^\/new$/, () => docForm()],
  [/^\/copy\/(\d+)$/, id => docForm(null, id)],
  [/^\/edit\/(\d+)$/, id => docForm(id)],
  [/^\/doc\/(\d+)$/, docView],
  [/^\/customers$/, () => crudPage(CUSTOMERS)],
  [/^\/products$/, () => crudPage(PRODUCTS)],
  [/^\/reports$/, reports],
  [/^\/settings$/, settingsPage],
];
async function route() {
  const p = location.hash.slice(1) || '/';
  for (const [re, fn] of ROUTES) {
    const m = re.exec(p);
    if (!m) continue;
    for (const a of document.querySelectorAll('[data-nav]')) a.classList.toggle('on', a.dataset.nav === p);
    view.onclick = null;
    try {
      await fn(...m.slice(1));
    } catch (err) {
      view.innerHTML = `<div class="card empty">${esc(err.message)}</div>`;
    }
    window.scrollTo(0, 0);
    return;
  }
  location.hash = '#/';
}
window.addEventListener('hashchange', () => S.user && route());

// ---------- ตารางเอกสาร ----------
function docTable(docs, emptyText = 'ไม่มีเอกสาร') {
  if (!docs.length) return `<div class="empty">${emptyText}</div>`;
  return `<table class="list"><thead><tr><th>เลขที่</th><th>วันที่</th><th>ลูกค้า</th><th>เรื่อง</th><th>ผู้ขาย</th><th class="r">ยอดรวม</th><th>สถานะ</th></tr></thead><tbody>
    ${docs.map(d => `<tr class="click" data-href="#/doc/${d.id}">
      <td class="nowrap"><a href="#/doc/${d.id}">${esc(d.number)}</a></td><td class="nowrap">${thDate(d.date)}</td>
      <td>${esc(d.customer.name)}</td><td>${esc(d.subject)}</td><td>${esc(d.owner_name)}</td>
      <td class="r">${money(d.total)}</td><td>${badge(d.display_status)}</td></tr>`).join('')}
  </tbody></table>`;
}
function rowLinks() {
  view.onclick = e => {
    const tr = e.target.closest('tr[data-href]');
    if (tr && !e.target.closest('a, button')) location.hash = tr.dataset.href;
  };
}

// ---------- ภาพรวม ----------
async function dashboard() {
  const docs = (await api('GET', '/api/docs?type=QT')).filter(d => d.status !== 'cancelled');
  const month = docs.filter(d => d.date.startsWith(S.today.slice(0, 7)));
  const year = docs.filter(d => d.date.startsWith(S.today.slice(0, 4)));
  const pending = docs.filter(d => d.status === 'pending');
  const returned = docs.filter(d => d.status === 'returned' && d.owner_id === S.user.id);
  const soon = docs.filter(d => ['approved', 'sent'].includes(d.display_status) && d.valid_until && d.valid_until <= addDays(S.today, 7));
  const won = year.filter(d => d.status === 'accepted').length;
  const closed = won + year.filter(d => ['declined', 'expired'].includes(d.display_status)).length;
  const stat = (label, v) => `<div class="stat"><div class="muted">${label}</div><div class="v">${v}</div></div>`;
  view.innerHTML = `<div class="top"><h1>ภาพรวม</h1><div class="acts"><a class="btn primary" href="#/new">+ สร้างใบเสนอราคา</a></div></div>
    <div class="stats">
      ${stat('รออนุมัติ', `${pending.length} ใบ`)}
      ${stat('ยอดเสนอราคาเดือนนี้', money(sum(month, d => d.total)))}
      ${stat('ลูกค้าตอบรับเดือนนี้', money(sum(month.filter(d => d.status === 'accepted'), d => d.total)))}
      ${stat('อัตราปิดการขายปีนี้', closed ? Math.round(won * 100 / closed) + '%' : '-')}
    </div>
    ${returned.length ? `<div class="card"><h2>ถูกส่งกลับให้แก้ไข</h2>${docTable(returned)}</div>` : ''}
    <div class="card"><h2>รออนุมัติ</h2>${docTable(pending, 'ไม่มีใบเสนอราคาที่รออนุมัติ')}</div>
    <div class="card"><h2>ใกล้หมดอายุภายใน 7 วัน (ลูกค้ายังไม่ตอบ)</h2>${docTable(soon, 'ไม่มีรายการ')}</div>
    <div class="card"><h2>ใบเสนอราคาล่าสุด</h2>${docTable(docs.slice(0, 8), 'ยังไม่มีใบเสนอราคา')}</div>`;
  rowLinks();
}

// ---------- รายการเอกสาร ----------
async function docList(type) {
  const docs = await api('GET', `/api/docs?type=${type}`);
  const statuses = [...new Set(docs.map(d => d.display_status))];
  view.innerHTML = `<div class="top"><h1>${TYPES[type]}</h1><div class="acts">${type === 'QT' ? '<a class="btn primary" href="#/new">+ สร้างใบเสนอราคา</a>' : ''}</div></div>
    <div class="card">
      <div class="filters">
        <input id="q" placeholder="ค้นหาเลขที่ / ลูกค้า / เรื่อง">
        <select id="st"><option value="">ทุกสถานะ</option>${statuses.map(s => `<option value="${s}">${STATUS[s][0]}</option>`).join('')}</select>
        <input id="mo" type="month" title="เดือน">
      </div>
      <div id="rows"></div>
    </div>`;
  const draw = () => {
    const q = $('#q').value.trim().toLowerCase();
    const st = $('#st').value;
    const mo = $('#mo').value;
    const rows = docs.filter(d => (!st || d.display_status === st) && (!mo || d.date.startsWith(mo))
      && (!q || `${d.number} ${d.customer.name} ${d.subject}`.toLowerCase().includes(q)));
    $('#rows').innerHTML = docTable(rows, type === 'QT' ? 'ไม่พบใบเสนอราคา' : `ยังไม่มี${TYPES[type]} — สร้างได้จากใบเสนอราคาที่ลูกค้าตอบรับแล้ว`)
      + (rows.length ? `<p class="muted r">${rows.length} รายการ รวม ${money(sum(rows, d => d.total))} บาท</p>` : '');
  };
  for (const id of ['#q', '#st', '#mo']) $(id).oninput = draw;
  draw();
  rowLinks();
}

// ---------- ฟอร์มสร้าง / แก้ไขเอกสาร ----------
function totalsHtml(F) {
  const t = Calc.totals(F);
  const row = (k, v, cls = '') => `<tr class="${cls}"><td>${k}</td><td class="r">${money(v)}</td></tr>`;
  return row('รวมเป็นเงิน', t.subtotal)
    + (t.discount_amount ? row('ส่วนลดท้ายบิล', -t.discount_amount) : '')
    + (F.vat_mode !== 'none' ? row('มูลค่าก่อนภาษี', t.net) + row(`ภาษีมูลค่าเพิ่ม ${Calc.num(F.vat_rate)}%`, t.vat_amount) : '')
    + row('จำนวนเงินรวมทั้งสิ้น', t.total, 'total')
    + (t.wht_amount ? row(`หัก ณ ที่จ่าย ${Calc.num(F.wht_rate)}%`, -t.wht_amount) + row('ยอดชำระสุทธิ', t.payable) : '');
}

async function docForm(id, copyId) {
  const [customers, products, src] = await Promise.all([
    api('GET', '/api/customers'), api('GET', '/api/products'),
    id || copyId ? api('GET', `/api/docs/${id || copyId}`) : null,
  ]);
  const s = S.settings;
  const type = id ? src.type : 'QT';
  const validUntil = addDays(S.today, Number(s.default_valid_days) || 30);
  const blank = () => ({ name: '', description: '', qty: 1, unit: '', price: 0, discount: 0 });
  const F = src ? {
    date: src.date, valid_until: src.valid_until, customer_id: src.customer_id, subject: src.subject,
    vat_mode: src.vat_mode, vat_rate: src.vat_rate, discount_type: src.discount_type, discount_value: src.discount_value,
    wht_rate: src.wht_rate, note: src.note, terms: src.terms, items: src.items,
  } : {
    date: S.today, valid_until: validUntil, customer_id: '', subject: '', vat_mode: s.default_vat_mode, vat_rate: Number(s.vat_rate),
    discount_type: 'amount', discount_value: 0, wht_rate: 0, note: '', terms: s.default_terms, items: [blank()],
  };
  if (copyId) Object.assign(F, { date: S.today, valid_until: validUntil });
  // ลูกค้าที่ถูกลบไปแล้วยังต้องเลือกได้ในเอกสารเดิม
  if (src && !customers.some(c => c.id === src.customer_id)) customers.push({ id: src.customer_id, name: src.customer.name });

  const custOptions = () => '<option value="">— เลือกลูกค้า —</option>'
    + customers.map(c => `<option value="${c.id}" ${c.id == F.customer_id ? 'selected' : ''}>${esc(c.name)}${c.code ? ` (${esc(c.code)})` : ''}</option>`).join('');
  const sel = (name, opts) => `<select name="${name}">${opts.map(([v, l]) => `<option value="${v}" ${String(F[name]) === String(v) ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
  const whtRates = [...new Set([0, 1, 2, 3, 5, Calc.num(F.wht_rate)])].sort((a, b) => a - b);
  const rowHtml = (it, i) => `<tr data-i="${i}">
    <td class="c" style="padding-top:11px">${i + 1}</td>
    <td><input data-f="name" list="plist" value="${esc(it.name)}" placeholder="ชื่อสินค้า / บริการ (พิมพ์เพื่อค้นหา)">
        <input data-f="description" class="sub" value="${esc(it.description)}" placeholder="รายละเอียดเพิ่มเติม (ถ้ามี)"></td>
    <td><input data-f="qty" type="number" step="any" min="0" value="${esc(it.qty)}"></td>
    <td><input data-f="unit" value="${esc(it.unit)}"></td>
    <td><input data-f="price" type="number" step="any" min="0" value="${esc(it.price)}"></td>
    <td><input data-f="discount" type="number" step="any" min="0" max="100" value="${esc(it.discount)}"></td>
    <td class="r amt">${money(Calc.lineAmount(it))}</td>
    <td><button type="button" class="icon" data-act="del" title="ลบรายการ">✕</button></td></tr>`;

  view.innerHTML = `<form id="docform">
    <div class="top"><h1>${id ? `แก้ไข${TYPES[type]} ${esc(src.number)}` : 'สร้างใบเสนอราคา'}</h1>
      <div class="acts"><a class="btn" href="${id ? `#/doc/${id}` : '#/docs/QT'}">ยกเลิก</a><button class="btn primary">บันทึก</button>
      ${type === 'QT' ? '<button type="button" class="btn ok" data-act="submit">บันทึกและส่งขออนุมัติ</button>' : ''}</div></div>
    <div class="card"><div class="grid">
      <div class="w2"><label>ลูกค้า *</label><div class="inline"><select name="customer_id" required>${custOptions()}</select><button type="button" class="btn" data-act="newcust">+ ลูกค้าใหม่</button></div></div>
      <div><label>วันที่</label><input type="date" name="date" value="${esc(F.date)}" required></div>
      <div><label>${DUE_LABEL[type]}</label><input type="date" name="valid_until" value="${esc(F.valid_until)}"></div>
      <div class="w4"><label>เรื่อง / โครงการ</label><input name="subject" value="${esc(F.subject)}"></div>
    </div></div>
    <div class="card"><h2>รายการสินค้า / บริการ</h2>
      <table class="items"><thead><tr><th style="width:36px">#</th><th>รายการ</th><th style="width:90px">จำนวน</th><th style="width:90px">หน่วย</th>
        <th style="width:130px">ราคา/หน่วย</th><th style="width:90px">ส่วนลด %</th><th class="r" style="width:120px">จำนวนเงิน</th><th style="width:34px"></th></tr></thead>
        <tbody id="items"></tbody></table>
      <button type="button" class="btn" data-act="add" style="margin-top:8px">+ เพิ่มรายการ</button>
      <datalist id="plist">${products.map(p => `<option value="${esc(p.name)}">${esc([p.code, `${money(p.price)} บาท${p.unit ? '/' + p.unit : ''}`].filter(Boolean).join(' · '))}</option>`).join('')}</datalist>
    </div>
    <div class="card"><div class="cols">
      <div>
        <label>หมายเหตุ</label><textarea name="note">${esc(F.note)}</textarea>
        <label style="margin-top:10px">เงื่อนไข</label><textarea name="terms" rows="4">${esc(F.terms)}</textarea>
      </div>
      <div class="sumbox">
        <div class="grid" style="grid-template-columns:1fr 1fr">
          <div><label>ภาษีมูลค่าเพิ่ม</label>${sel('vat_mode', [['exclusive', 'ราคายังไม่รวม VAT'], ['inclusive', 'ราคารวม VAT แล้ว'], ['none', 'ไม่มี VAT']])}</div>
          <div><label>อัตรา VAT %</label><input type="number" step="any" min="0" name="vat_rate" value="${esc(F.vat_rate)}"></div>
          <div><label>ส่วนลดท้ายบิล</label><div class="inline"><input type="number" step="any" min="0" name="discount_value" value="${esc(F.discount_value)}">${sel('discount_type', [['amount', 'บาท'], ['percent', '%']])}</div></div>
          <div><label>หัก ณ ที่จ่าย</label>${sel('wht_rate', whtRates.map(r => [r, r ? r + '%' : 'ไม่หัก']))}</div>
        </div>
        <table style="margin-top:12px" id="totals"></table>
      </div>
    </div></div>
  </form>`;

  const form = $('#docform');
  const drawItems = () => { $('#items').innerHTML = F.items.map(rowHtml).join(''); };
  const drawTotals = () => { $('#totals').innerHTML = totalsHtml(F); };
  drawItems();
  drawTotals();

  form.addEventListener('input', e => {
    const el = e.target;
    const tr = el.closest('tr[data-i]');
    if (tr && el.dataset.f) {
      const it = F.items[tr.dataset.i];
      it[el.dataset.f] = el.value;
      // เลือกสินค้าจากรายการ -> เติมหน่วยและราคาให้
      const p = el.dataset.f === 'name' && products.find(x => x.name === el.value);
      if (p) {
        Object.assign(it, { unit: p.unit || '', price: p.price, description: it.description || p.description || '' });
        for (const f of ['unit', 'price', 'description']) $(`[data-f="${f}"]`, tr).value = it[f];
      }
      $('.amt', tr).textContent = money(Calc.lineAmount(it));
    } else if (el.name) F[el.name] = el.value;
    drawTotals();
  });
  form.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.tagName === 'INPUT') e.preventDefault();
  });

  const save = safe(async thenSubmit => {
    if (!form.reportValidity()) return;
    const r = id ? await api('PUT', `/api/docs/${id}`, F) : await api('POST', '/api/docs', F);
    if (thenSubmit) await api('POST', `/api/docs/${r.id}/action`, { action: 'submit' });
    toast('บันทึกแล้ว');
    location.hash = `#/doc/${r.id}`;
  });
  form.onsubmit = e => { e.preventDefault(); save(false); };
  form.onclick = safe(async e => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'add') {
      F.items.push(blank());
      drawItems();
      $(`#items tr:last-child [data-f="name"]`).focus();
    } else if (act === 'del') {
      F.items.splice(e.target.closest('tr').dataset.i, 1);
      if (!F.items.length) F.items.push(blank());
      drawItems();
      drawTotals();
    } else if (act === 'submit') {
      save(true);
    } else if (act === 'newcust') {
      const c = await editRecord(CUSTOMERS);
      customers.push(c);
      F.customer_id = c.id;
      form.customer_id.innerHTML = custOptions();
    }
  });
}

// ---------- ดูเอกสาร ----------
async function docView(id) {
  const d = await api('GET', `/api/docs/${id}`);
  const mine = S.user.role !== 'sales' || d.owner_id === S.user.id;
  const approver = S.user.role !== 'sales';
  const st = d.status;
  const is = (...list) => list.includes(st);
  const btn = (act, label, cls = '') => `<button class="btn ${cls}" data-act="${act}">${label}</button>`;
  const hasChild = t => d.children.some(c => c.type === t);
  const B = [];
  if (mine && is('draft', 'returned', 'open')) B.push(`<a class="btn" href="#/edit/${d.id}">แก้ไข</a>`);
  if (d.type === 'QT') {
    if (mine && is('draft', 'returned')) B.push(btn('submit', 'ส่งขออนุมัติ', 'primary'));
    if (approver && is('pending')) B.push(btn('approve', 'อนุมัติ', 'ok'), btn('return', 'ส่งกลับแก้ไข', 'danger'));
    if (is('approved', 'sent', 'accepted')) B.push(btn('line', 'ส่งทาง LINE', 'line'));
    if (mine && is('approved')) B.push(btn('send', 'บันทึกว่าส่งแล้ว'));
    if (mine && is('approved', 'sent')) B.push(btn('accept', 'ลูกค้าตอบรับ', 'ok'), btn('decline', 'ลูกค้าปฏิเสธ'));
    if (mine && is('accepted') && !hasChild('SO')) B.push(btn('to-SO', 'สร้างใบสั่งขาย', 'primary'));
    if (mine && is('accepted') && !hasChild('IV')) B.push(btn('to-IV', 'สร้างใบแจ้งหนี้', 'primary'));
    if (mine && is('pending', 'approved', 'sent', 'declined')) B.push(btn('revise', 'ดึงกลับมาแก้ไข'));
    B.push(`<a class="btn" href="#/copy/${d.id}">คัดลอกเป็นใบใหม่</a>`);
  }
  if (d.type === 'SO' && mine && is('open') && !hasChild('IV')) B.push(btn('to-IV', 'สร้างใบแจ้งหนี้', 'primary'));
  if (d.type === 'IV' && mine && is('open')) B.push(btn('paid', 'บันทึกรับชำระ', 'ok'));
  B.push(`<a class="btn" href="/print/${d.id}" target="_blank">พิมพ์ / PDF</a>`);
  if (mine && !is('cancelled')) B.push(btn('cancel', 'ยกเลิกเอกสาร', 'danger'));

  const info = (k, v) => (v ? `<tr><td class="muted nowrap">${k}</td><td>${v}</td></tr>` : '');
  view.innerHTML = `<div class="top"><h1>${TYPES[d.type]} ${esc(d.number)} ${badge(d.display_status)}</h1><div class="acts">${B.join('')}</div></div>
    <div class="viewcols">
      <iframe class="preview" src="/print/${d.id}?embed=1" title="ตัวอย่างเอกสาร"></iframe>
      <div>
        <div class="card"><table>
          ${info('ลูกค้า', esc(d.customer.name))}
          ${info('ยอดรวม', money(d.total) + ' บาท')}
          ${info('ผู้ขาย', esc(d.owner_name))}
          ${info('ผู้อนุมัติ', esc(d.approver_name))}
          ${info('อ้างอิง', d.source_id ? `<a href="#/doc/${d.source_id}">${esc(d.source_number)}</a>` : '')}
          ${info('เอกสารต่อเนื่อง', d.children.map(c => `<a href="#/doc/${c.id}">${esc(c.number)}</a>`).join('<br>'))}
        </table></div>
        <div class="card"><h2>ประวัติเอกสาร</h2><ul class="log">
          ${d.log.map(l => `<li><strong>${LOG[l.action] || esc(l.action)}</strong>${l.note ? ` — ${esc(l.note)}` : ''}
            <div class="muted">${esc(l.user_name || 'ระบบ')} · ${new Date(l.at).toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short' })}</div></li>`).join('')}
        </ul></div>
      </div>
    </div>`;

  const act = async (action, note) => {
    await api('POST', `/api/docs/${d.id}/action`, { action, note });
    toast('บันทึกแล้ว');
    docView(d.id);
  };
  const askNote = (title, action, required) => modal({
    title, ok: 'ยืนยัน',
    body: `<label>เหตุผล / หมายเหตุ${required ? ' *' : ''}</label><textarea name="note" ${required ? 'required' : ''}></textarea>`,
    onOk: fd => act(action, fd.get('note')),
  });
  view.onclick = safe(async e => {
    const a = e.target.closest('[data-act]')?.dataset.act;
    if (!a) return;
    if (a === 'line') return lineDialog(d, act);
    if (a === 'return') return askNote('ส่งกลับให้แก้ไข', 'return', true);
    if (a === 'decline') return askNote('ลูกค้าปฏิเสธ', 'decline', false);
    if (a === 'cancel') return askNote(`ยกเลิก ${d.number}`, 'cancel', false);
    if (a === 'revise' && !confirm('ดึงกลับมาเป็นฉบับร่างเพื่อแก้ไข? จะต้องส่งขออนุมัติใหม่อีกครั้ง')) return;
    if (a.startsWith('to-')) {
      const r = await api('POST', `/api/docs/${d.id}/convert`, { type: a.slice(3) });
      toast(`สร้าง${TYPES[a.slice(3)]}แล้ว`);
      location.hash = `#/doc/${r.id}`;
      return;
    }
    await act(a);
  });
}

async function lineDialog(d, act) {
  toast('กำลังสร้างไฟล์ PDF...');
  const pdf = await api('POST', `/api/docs/${d.id}/pdf`);
  const c = d.customer;
  const vars = {
    contact: c.contact || c.name, customer: c.name, company: S.settings.company_name, number: d.number,
    subject: d.subject ? `เรื่อง ${d.subject}` : '', total: money(d.total), valid_until: thDate(d.valid_until) || '-', sender: S.user.name,
  };
  const msg = S.settings.line_template.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
  const el = modal({
    title: `ส่ง ${d.number} ทาง LINE`, wide: true,
    ok: d.status === 'approved' ? 'บันทึกว่าส่งแล้ว' : undefined,
    onOk: d.status === 'approved' ? () => act('send', 'ส่งทาง LINE') : undefined,
    body: `<p>สร้างไฟล์ <strong>${esc(pdf.name)}</strong> เรียบร้อยแล้ว${c.line_id ? ` · LINE ของลูกค้า: <strong>${esc(c.line_id)}</strong>` : ''}</p>
      <ol class="muted" style="padding-left:20px">
        <li>กด “เปิด LINE” แล้วเลือกแชตของลูกค้า ข้อความด้านล่างจะถูกใส่ให้อัตโนมัติ</li>
        <li>กด “เปิดโฟลเดอร์ไฟล์ PDF” แล้วลากไฟล์ไปวางในแชตเดียวกัน</li>
      </ol>
      <label>ข้อความถึงลูกค้า</label><textarea id="linemsg" rows="6">${esc(msg)}</textarea>
      <div class="top" style="margin:12px 0 0;justify-content:flex-start">
        <button type="button" class="btn line" data-l="open">เปิด LINE</button>
        <button type="button" class="btn" data-l="reveal">เปิดโฟลเดอร์ไฟล์ PDF</button>
        <button type="button" class="btn" data-l="copy">คัดลอกข้อความ</button>
        <a class="btn" href="${pdf.url}" download>ดาวน์โหลด PDF</a>
      </div>`,
  });
  el.addEventListener('click', safe(async e => {
    const a = e.target.dataset.l;
    const text = $('#linemsg', el).value;
    if (a === 'open') window.open('https://line.me/R/share?text=' + encodeURIComponent(text), '_blank');
    if (a === 'reveal') await api('POST', `/api/docs/${d.id}/reveal`);
    if (a === 'copy') {
      await navigator.clipboard.writeText(text);
      toast('คัดลอกข้อความแล้ว');
    }
  }));
}

// ---------- ลูกค้า / สินค้า ----------
const CUSTOMERS = {
  key: 'customers', title: 'ลูกค้า', one: 'ลูกค้า',
  fields: [['name', 'ชื่อลูกค้า / บริษัท', { req: 1, w: 1 }], ['code', 'รหัสลูกค้า'], ['tax_id', 'เลขประจำตัวผู้เสียภาษี'], ['branch', 'สาขา'],
    ['contact', 'ผู้ติดต่อ'], ['phone', 'โทรศัพท์'], ['email', 'อีเมล'], ['line_id', 'LINE ID'], ['address', 'ที่อยู่', { area: 1, w: 1 }], ['note', 'หมายเหตุ', { area: 1, w: 1 }]],
  cols: [['code', 'รหัส'], ['name', 'ชื่อ'], ['contact', 'ผู้ติดต่อ'], ['phone', 'โทรศัพท์'], ['line_id', 'LINE ID']],
};
const PRODUCTS = {
  key: 'products', title: 'สินค้า / บริการ', one: 'สินค้า / บริการ',
  fields: [['name', 'ชื่อสินค้า / บริการ', { req: 1, w: 1 }], ['code', 'รหัสสินค้า'], ['unit', 'หน่วยนับ'], ['price', 'ราคาต่อหน่วย (บาท)', { num: 1 }], ['description', 'รายละเอียด', { area: 1, w: 1 }]],
  cols: [['code', 'รหัส'], ['name', 'ชื่อ'], ['unit', 'หน่วย'], ['price', 'ราคา/หน่วย', { money: 1 }]],
};

function editRecord(def, rec = {}) {
  return new Promise(resolve => {
    const field = ([k, label, o = {}]) => `<div class="${o.w ? 'w2' : ''}"><label>${label}${o.req ? ' *' : ''}</label>${o.area
      ? `<textarea name="${k}">${esc(rec[k])}</textarea>`
      : `<input name="${k}" ${o.num ? 'type="number" step="any" min="0"' : ''} ${o.req ? 'required' : ''} value="${esc(rec[k])}">`}</div>`;
    modal({
      title: (rec.id ? 'แก้ไข' : 'เพิ่ม') + def.one, wide: true,
      body: `<div class="grid">${def.fields.map(field).join('')}</div>`,
      onOk: async fd => {
        const body = Object.fromEntries(fd);
        resolve(rec.id ? await api('PUT', `/api/${def.key}/${rec.id}`, body) : await api('POST', `/api/${def.key}`, body));
        toast('บันทึกแล้ว');
      },
    });
  });
}

async function crudPage(def) {
  let rows = await api('GET', `/api/${def.key}`);
  view.innerHTML = `<div class="top"><h1>${def.title}</h1><div class="acts"><button class="btn primary" data-act="add">+ เพิ่ม${def.one}</button></div></div>
    <div class="card"><div class="filters"><input id="q" placeholder="ค้นหา"></div><div id="rows"></div></div>`;
  const draw = () => {
    const q = $('#q').value.trim().toLowerCase();
    const list = rows.filter(r => !q || def.cols.some(([k]) => String(r[k] ?? '').toLowerCase().includes(q)));
    $('#rows').innerHTML = list.length ? `<table class="list"><thead><tr>${def.cols.map(([, l, o = {}]) => `<th class="${o.money ? 'r' : ''}">${l}</th>`).join('')}<th></th></tr></thead><tbody>
      ${list.map(r => `<tr data-id="${r.id}">${def.cols.map(([k, , o = {}]) => `<td class="${o.money ? 'r' : ''}">${o.money ? money(r[k]) : esc(r[k])}</td>`).join('')}
        <td class="r nowrap"><button class="btn sm" data-act="edit">แก้ไข</button> <button class="btn sm danger" data-act="del">ลบ</button></td></tr>`).join('')}
      </tbody></table>` : `<div class="empty">ยังไม่มีข้อมูล${def.one}</div>`;
  };
  const reload = async () => {
    rows = await api('GET', `/api/${def.key}`);
    draw();
  };
  $('#q').oninput = draw;
  draw();
  view.onclick = safe(async e => {
    const a = e.target.closest('[data-act]')?.dataset.act;
    const rec = rows.find(r => r.id == e.target.closest('tr')?.dataset.id);
    if (a === 'add') await editRecord(def);
    else if (a === 'edit') await editRecord(def, rec);
    else if (a === 'del' && confirm(`ลบ “${rec.name}” ? (เอกสารเดิมที่ใช้ข้อมูลนี้จะไม่เปลี่ยนแปลง)`)) await api('DELETE', `/api/${def.key}/${rec.id}`);
    else return;
    await reload();
  });
}

// ---------- รายงาน ----------
async function reports() {
  const docs = (await api('GET', '/api/docs?type=QT')).filter(d => d.status !== 'cancelled');
  const years = [...new Set([S.today.slice(0, 4), ...docs.map(d => d.date.slice(0, 4))])].sort().reverse();
  view.innerHTML = `<div class="top"><h1>รายงานใบเสนอราคา</h1><div class="acts"><select id="yr">${years.map(y => `<option value="${y}">ปี ${Number(y) + 543}</option>`).join('')}</select></div></div><div id="rep"></div>`;
  const won = list => list.filter(d => d.status === 'accepted');
  const total = list => sum(list, d => d.total);
  const bar = (v, max, cls = '') => `<div class="bar"><i class="${cls}" style="width:${max ? Math.round(v * 100 / max) : 0}%"></i></div>`;
  const draw = () => {
    const list = docs.filter(d => d.date.startsWith($('#yr').value));
    const byMonth = MONTHS.map((name, i) => ({ name, list: list.filter(d => Number(d.date.slice(5, 7)) === i + 1) }));
    const maxMonth = Math.max(...byMonth.map(m => total(m.list)));
    const owners = [...new Set(list.map(d => d.owner_name))].map(name => ({ name, list: list.filter(d => d.owner_name === name) }))
      .sort((a, b) => total(b.list) - total(a.list));
    const statuses = Object.keys(STATUS).map(st => ({ st, list: list.filter(d => d.display_status === st) })).filter(x => x.list.length);
    const rate = l => {
      const closed = l.filter(d => ['accepted', 'declined', 'expired'].includes(d.display_status)).length;
      return closed ? Math.round(won(l).length * 100 / closed) + '%' : '-';
    };
    $('#rep').innerHTML = `
      <div class="stats">
        <div class="stat"><div class="muted">จำนวนใบเสนอราคา</div><div class="v">${list.length}</div></div>
        <div class="stat"><div class="muted">ยอดเสนอราคารวม</div><div class="v">${money(total(list))}</div></div>
        <div class="stat"><div class="muted">ยอดที่ลูกค้าตอบรับ</div><div class="v">${money(total(won(list)))}</div></div>
        <div class="stat"><div class="muted">อัตราปิดการขาย</div><div class="v">${rate(list)}</div></div>
      </div>
      <div class="card"><h2>สรุปรายเดือน</h2><table class="list"><thead><tr><th>เดือน</th><th class="r">จำนวนใบ</th><th class="r">ยอดเสนอราคา</th><th></th><th class="r">ตอบรับ (ใบ)</th><th class="r">ยอดตอบรับ</th><th></th></tr></thead><tbody>
        ${byMonth.map(m => `<tr><td>${m.name}</td><td class="r">${m.list.length}</td><td class="r">${money(total(m.list))}</td><td>${bar(total(m.list), maxMonth)}</td>
          <td class="r">${won(m.list).length}</td><td class="r">${money(total(won(m.list)))}</td><td>${bar(total(won(m.list)), maxMonth, 'g')}</td></tr>`).join('')}
      </tbody></table></div>
      <div class="cols">
        <div class="card"><h2>แยกตามพนักงานขาย</h2>${owners.length ? `<table class="list"><thead><tr><th>ชื่อ</th><th class="r">จำนวนใบ</th><th class="r">ยอดเสนอ</th><th class="r">ยอดตอบรับ</th><th class="r">ปิดการขาย</th></tr></thead><tbody>
          ${owners.map(o => `<tr><td>${esc(o.name)}</td><td class="r">${o.list.length}</td><td class="r">${money(total(o.list))}</td><td class="r">${money(total(won(o.list)))}</td><td class="r">${rate(o.list)}</td></tr>`).join('')}
        </tbody></table>` : '<div class="empty">ไม่มีข้อมูล</div>'}</div>
        <div class="card"><h2>แยกตามสถานะ</h2>${statuses.length ? `<table class="list"><thead><tr><th>สถานะ</th><th class="r">จำนวนใบ</th><th class="r">ยอดรวม</th></tr></thead><tbody>
          ${statuses.map(x => `<tr><td>${badge(x.st)}</td><td class="r">${x.list.length}</td><td class="r">${money(total(x.list))}</td></tr>`).join('')}
        </tbody></table>` : '<div class="empty">ไม่มีข้อมูล</div>'}</div>
      </div>`;
  };
  $('#yr').onchange = draw;
  draw();
}

// ---------- ตั้งค่า ----------
async function settingsPage() {
  const admin = S.user.role === 'admin';
  const s = S.settings;
  const inp = (k, label, o = {}) => `<div class="${o.cls || ''}"><label>${label}</label>${o.area
    ? `<textarea name="${k}" rows="${o.rows || 3}">${esc(s[k])}</textarea>`
    : `<input name="${k}" ${o.num ? 'type="number" step="any" min="0"' : ''} value="${esc(s[k])}">`}${o.hint ? `<div class="muted" style="font-size:12.5px;margin-top:3px">${o.hint}</div>` : ''}</div>`;
  let logo = s.logo;
  view.innerHTML = `<div class="top"><h1>ตั้งค่า</h1></div>
    ${admin ? `<form class="card" id="setform"><h2>ข้อมูลบริษัท (แสดงบนหัวเอกสาร)</h2><div class="grid">
        ${inp('company_name', 'ชื่อบริษัท / องค์กร', { cls: 'w2' })}${inp('company_tax_id', 'เลขประจำตัวผู้เสียภาษี')}${inp('company_branch', 'สาขา')}
        ${inp('company_address', 'ที่อยู่', { area: 1, cls: 'w2' })}${inp('company_phone', 'โทรศัพท์')}${inp('company_email', 'อีเมล')}
        <div><label>สีหลักของเอกสาร</label><input type="color" name="brand_color" value="${esc(s.brand_color)}" style="height:38px;padding:3px"></div>
        <div class="w2" style="grid-column:span 3"><label>โลโก้ (ไฟล์รูปไม่เกิน 700 KB)</label><div class="inline" style="align-items:center">
          <input type="file" id="logofile" accept="image/png,image/jpeg"><img id="logoimg" style="max-height:48px"><button type="button" class="btn sm" id="logodel">ลบโลโก้</button></div></div>
      </div>
      <h2 style="margin-top:20px">ค่าเริ่มต้นของเอกสาร</h2><div class="grid">
        ${inp('default_valid_days', 'ยืนราคา (วัน)', { num: 1 })}
        <div><label>ภาษีมูลค่าเพิ่ม</label><select name="default_vat_mode">${[['exclusive', 'ราคายังไม่รวม VAT'], ['inclusive', 'ราคารวม VAT แล้ว'], ['none', 'ไม่มี VAT']]
    .map(([v, l]) => `<option value="${v}" ${s.default_vat_mode === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        ${inp('vat_rate', 'อัตรา VAT %', { num: 1 })}
        ${inp('approval_min', 'ต้องอนุมัติเมื่อยอดรวมตั้งแต่ (บาท)', { num: 1, hint: '0 = ต้องอนุมัติทุกใบ ยอดต่ำกว่านี้อนุมัติอัตโนมัติ' })}
        ${inp('default_terms', 'เงื่อนไขท้ายเอกสาร', { area: 1, cls: 'w2', rows: 5 })}
        ${inp('line_template', 'ข้อความส่งลูกค้าทาง LINE', { area: 1, cls: 'w2', rows: 5, hint: 'ตัวแปรที่ใช้ได้: {contact} {customer} {company} {number} {subject} {total} {valid_until} {sender}' })}
      </div>
      <div class="r" style="margin-top:14px"><button class="btn primary">บันทึกการตั้งค่า</button></div></form>
      <div class="card"><div class="top"><h2 style="margin:0">ผู้ใช้งาน</h2><button class="btn" id="adduser">+ เพิ่มผู้ใช้</button></div><div id="users"></div></div>` : ''}
    <form class="card" id="pwform"><h2>เปลี่ยนรหัสผ่านของฉัน</h2><div class="grid">
      <div><label>รหัสผ่านปัจจุบัน</label><input type="password" name="current" required autocomplete="current-password"></div>
      <div><label>รหัสผ่านใหม่ (อย่างน้อย 6 ตัวอักษร)</label><input type="password" name="password" minlength="6" required autocomplete="new-password"></div>
      <div style="align-self:end"><button class="btn">เปลี่ยนรหัสผ่าน</button></div></div></form>
    ${admin ? `<div class="card"><h2>สำรองข้อมูล</h2><p class="muted">ดาวน์โหลดไฟล์ฐานข้อมูลทั้งหมดเก็บไว้ที่อื่น (เช่น แฟลชไดรฟ์ หรือ Google Drive) เป็นประจำ</p>
      <a class="btn" href="/api/backup">ดาวน์โหลดไฟล์สำรอง</a></div>` : ''}`;

  $('#pwform').onsubmit = safe(async e => {
    e.preventDefault();
    await api('PUT', '/api/me/password', Object.fromEntries(new FormData(e.target)));
    e.target.reset();
    toast('เปลี่ยนรหัสผ่านแล้ว');
  });
  if (!admin) return;

  const showLogo = () => {
    $('#logoimg').src = logo || '';
    $('#logoimg').hidden = $('#logodel').hidden = !logo;
  };
  showLogo();
  $('#logodel').onclick = () => { logo = ''; $('#logofile').value = ''; showLogo(); };
  $('#logofile').onchange = e => {
    const f = e.target.files[0];
    if (!f) return;
    if (f.size > 700 * 1024) {
      e.target.value = '';
      return toast('ไฟล์โลโก้ใหญ่เกิน 700 KB', true);
    }
    const reader = new FileReader();
    reader.onload = () => { logo = reader.result; showLogo(); };
    reader.readAsDataURL(f);
  };
  $('#setform').onsubmit = safe(async e => {
    e.preventDefault();
    S.settings = await api('PUT', '/api/settings', { ...Object.fromEntries(new FormData(e.target)), logo });
    $('.side .brand').textContent = S.settings.company_name || 'ระบบใบเสนอราคา';
    toast('บันทึกการตั้งค่าแล้ว');
  });

  let users = [];
  const drawUsers = async () => {
    users = await api('GET', '/api/users');
    $('#users').innerHTML = `<table class="list"><thead><tr><th>ชื่อผู้ใช้</th><th>ชื่อ-นามสกุล</th><th>บทบาท</th><th>สถานะ</th><th></th></tr></thead><tbody>
      ${users.map(u => `<tr><td>${esc(u.username)}</td><td>${esc(u.name)}</td><td>${ROLES[u.role]}</td><td>${u.active ? '<span class="badge green">ใช้งาน</span>' : '<span class="badge gray">ปิดใช้งาน</span>'}</td>
        <td class="r"><button class="btn sm" data-user="${u.id}">แก้ไข</button></td></tr>`).join('')}</tbody></table>`;
  };
  const userDialog = (u = {}) => modal({
    title: u.id ? `แก้ไขผู้ใช้ ${u.username}` : 'เพิ่มผู้ใช้',
    body: `<div class="grid">
      ${u.id ? '' : '<div><label>ชื่อผู้ใช้ *</label><input name="username" required></div>'}
      <div><label>ชื่อ-นามสกุล *</label><input name="name" required value="${esc(u.name)}"></div>
      <div><label>บทบาท</label><select name="role">${Object.entries(ROLES).map(([v, l]) => `<option value="${v}" ${(u.role || 'sales') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div><label>${u.id ? 'รหัสผ่านใหม่ (เว้นว่างหากไม่เปลี่ยน)' : 'รหัสผ่าน * (อย่างน้อย 6 ตัวอักษร)'}</label><input name="password" type="password" minlength="6" ${u.id ? '' : 'required'} autocomplete="new-password"></div>
      ${u.id ? `<div><label>สถานะ</label><select name="active"><option value="1">ใช้งาน</option><option value="" ${u.active ? '' : 'selected'}>ปิดใช้งาน</option></select></div>` : ''}
    </div>
    <p class="muted" style="font-size:13px">พนักงานขาย: สร้างและแก้ไขเอกสารของตนเอง · ผู้อนุมัติ: อนุมัติและจัดการเอกสารทุกใบ · ผู้ดูแลระบบ: ทำได้ทุกอย่างรวมถึงตั้งค่า</p>`,
    onOk: async fd => {
      const body = Object.fromEntries(fd);
      if (u.id) await api('PUT', `/api/users/${u.id}`, body);
      else await api('POST', '/api/users', body);
      toast('บันทึกแล้ว');
      await drawUsers();
    },
  });
  $('#adduser').onclick = () => userDialog();
  $('#users').onclick = e => {
    const id = e.target.dataset.user;
    if (id) userDialog(users.find(u => u.id == id));
  };
  await drawUsers();
}

boot().catch(err => { $('#app').innerHTML = `<div class="center"><div class="card">${esc(err.message)}</div></div>`; });
