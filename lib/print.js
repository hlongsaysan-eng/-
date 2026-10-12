'use strict';
// สร้างหน้าเอกสาร A4 สำหรับพิมพ์ / แปลงเป็น PDF
const Calc = require('./calc');

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nl2br = s => esc(s).replace(/\r?\n/g, '<br>');

const TITLES = { QT: ['ใบเสนอราคา', 'QUOTATION'], SO: ['ใบสั่งขาย', 'SALES ORDER'], IV: ['ใบแจ้งหนี้', 'INVOICE'] };
const DUE_LABEL = { QT: 'ยืนราคาถึง', SO: 'กำหนดส่งมอบ', IV: 'ครบกำหนดชำระ' };
const SIGNERS = {
  QT: ['ผู้เสนอราคา', 'ผู้อนุมัติ', 'ลูกค้าผู้ยืนยันสั่งซื้อ'],
  SO: ['ผู้จัดทำ', 'ผู้อนุมัติ', 'ผู้รับเอกสาร'],
  IV: ['ผู้จัดทำ', 'ผู้อนุมัติ', 'ผู้รับวางบิล'],
};
const DEFAULT_ACCENT = '#1e3a8a';

function renderPrint(doc, settings, { embed = false } = {}) {
  const [titleTh, titleEn] = TITLES[doc.type];
  const c = doc.customer || {};
  const t = Calc.totals(doc);
  const m = Calc.money;
  const accent = /^#[0-9a-f]{6}$/i.test(settings.brand_color || '') ? settings.brand_color : DEFAULT_ACCENT;
  const hasLineDiscount = doc.items.some(it => Calc.num(it.discount) > 0);
  const watermark = doc.status === 'cancelled' ? 'ยกเลิก'
    : ['draft', 'pending', 'returned'].includes(doc.status) ? 'ฉบับร่าง' : '';

  const rows = doc.items.map((it, i) => `<tr>
    <td class="c">${i + 1}</td>
    <td><div class="iname">${esc(it.name)}</div>${it.description ? `<div class="desc">${nl2br(it.description)}</div>` : ''}</td>
    <td class="r">${Calc.num(it.qty).toLocaleString('en-US')}</td>
    <td class="c">${esc(it.unit)}</td>
    <td class="r">${m(it.price)}</td>
    ${hasLineDiscount ? `<td class="r">${Calc.num(it.discount) ? Calc.num(it.discount) + '%' : '-'}</td>` : ''}
    <td class="r">${m(Calc.lineAmount(it))}</td>
  </tr>`).join('');

  const sumRows = [['รวมเป็นเงิน', m(t.subtotal)]];
  if (t.discount_amount) {
    sumRows.push([`ส่วนลด${doc.discount_type === 'percent' ? ` ${Calc.num(doc.discount_value)}%` : ''}`, '-' + m(t.discount_amount)]);
  }
  if (doc.vat_mode !== 'none') {
    sumRows.push([doc.vat_mode === 'inclusive' ? 'มูลค่าก่อนภาษี (ราคารวมภาษีแล้ว)' : 'มูลค่าก่อนภาษี', m(t.net)]);
    sumRows.push([`ภาษีมูลค่าเพิ่ม ${Calc.num(doc.vat_rate)}%`, m(t.vat_amount)]);
  }
  const whtRows = t.wht_amount
    ? `<tr class="wht"><td>หัก ณ ที่จ่าย ${Calc.num(doc.wht_rate)}%</td><td class="r">-${m(t.wht_amount)}</td></tr>
       <tr class="wht"><td><strong>ยอดชำระสุทธิ</strong></td><td class="r"><strong>${m(t.payable)}</strong></td></tr>` : '';

  const [s1, s2, s3] = SIGNERS[doc.type];
  const sign = (label, name, date) => `<div class="sign">
    <div class="space"></div>
    <div class="who">( ${name ? esc(name) : '&nbsp;'.repeat(44)} )</div>
    <div class="role">${esc(label)}</div>
    <div class="muted">วันที่ ${date ? Calc.thDate(date) : '....... / ....... / .......'}</div>
  </div>`;

  const contactLine = [settings.company_phone && `โทร. ${esc(settings.company_phone)}`, settings.company_email && esc(settings.company_email)].filter(Boolean).join(' &nbsp;|&nbsp; ');
  const info = (k, v) => (v ? `<div class="k">${k}</div><div class="v">${v}</div>` : '');

  return `<!doctype html>
<html lang="th"><head><meta charset="utf-8">
<title>${esc(doc.number)}</title>
<style>
  @page { size: A4; margin: 11mm 12mm; }
  :root { --accent: ${accent}; --tint: color-mix(in srgb, var(--accent) 7%, #fff); --rule: color-mix(in srgb, var(--accent) 22%, #fff); --ink: #1b2330; --muted: #5f6b7a; }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { margin: 0; font-family: "Leelawadee UI", "Sarabun", Tahoma, sans-serif; font-size: 10.5pt; line-height: 1.45; color: var(--ink); background: #e9ecf1; }
  .bar { position: sticky; top: 0; z-index: 2; background: #1f2937; color: #fff; padding: 10px 16px; display: flex; gap: 12px; align-items: center; }
  .bar button { font: inherit; padding: 6px 16px; border: 0; border-radius: 6px; background: #2563eb; color: #fff; cursor: pointer; }
  .page { position: relative; width: 210mm; min-height: 297mm; margin: 14px auto; padding: 11mm 12mm; background: #fff; box-shadow: 0 2px 10px rgba(0,0,0,.15); overflow: hidden; }
  .wm { position: absolute; top: 36%; left: 0; right: 0; text-align: center; font-size: 92pt; font-weight: 700; color: rgba(200,0,0,.08); transform: rotate(-24deg); pointer-events: none; }
  .muted, .desc { color: var(--muted); }
  .c { text-align: center; } .r { text-align: right; white-space: nowrap; }

  /* หัวเอกสาร */
  .head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
  .co { display: flex; gap: 12px; align-items: flex-start; min-width: 0; }
  .co img { max-height: 68px; max-width: 110px; object-fit: contain; }
  .co h1 { margin: 0 0 3px; font-size: 14.5pt; line-height: 1.25; color: var(--accent); }
  .co .small { font-size: 9.5pt; color: var(--muted); }
  .title { text-align: right; flex-shrink: 0; }
  .title h2 { margin: 0; font-size: 25pt; line-height: 1.1; color: var(--accent); font-weight: 700; }
  .title .en { letter-spacing: 3.5px; font-size: 9.5pt; color: var(--muted); margin-top: 2px; }
  .rule { height: 3px; margin: 10px 0 12px; background: linear-gradient(90deg, var(--accent) 0 72%, var(--rule) 72% 100%); border-radius: 2px; }

  /* ลูกค้า + ข้อมูลเอกสาร */
  .meta { display: flex; gap: 12px; margin-bottom: 12px; }
  .cust { flex: 1; background: var(--tint); border-left: 4px solid var(--accent); border-radius: 0 6px 6px 0; padding: 9px 12px; }
  .label { font-size: 8.5pt; letter-spacing: .6px; color: var(--accent); font-weight: 700; margin-bottom: 2px; }
  .cust strong { font-size: 11.5pt; }
  .info { width: 70mm; border: 1px solid var(--rule); border-radius: 6px; padding: 9px 12px; display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; align-content: start; }
  .info .k { color: var(--muted); white-space: nowrap; }
  .info .v { text-align: right; font-weight: 600; }
  .info .v.no { color: var(--accent); font-size: 11.5pt; }
  .subject { margin: 0 0 10px; }
  .subject b { color: var(--accent); }

  /* ตารางรายการ */
  table.items { width: 100%; border-collapse: collapse; }
  table.items th { background: var(--accent); color: #fff; padding: 7px 8px; font-weight: 600; font-size: 9.5pt; }
  table.items th:first-child { border-radius: 6px 0 0 0; } table.items th:last-child { border-radius: 0 6px 0 0; }
  table.items td { padding: 6px 8px; border-bottom: 1px solid var(--rule); vertical-align: top; }
  table.items tbody tr:nth-child(even) td { background: var(--tint); }
  table.items tbody tr:last-child td { border-bottom: 2px solid var(--accent); }
  table.items tr { break-inside: avoid; }
  .iname { font-weight: 600; }
  .desc { font-size: 9.5pt; }

  /* สรุปยอด */
  .foot { display: flex; justify-content: space-between; gap: 16px; margin-top: 12px; break-inside: avoid; }
  .notes { flex: 1; min-width: 0; }
  .baht { background: var(--tint); border-radius: 6px; padding: 7px 12px; margin-bottom: 10px; }
  .baht span { display: block; font-size: 8.5pt; color: var(--muted); }
  .baht b { font-size: 10.5pt; }
  .notes h4 { margin: 0 0 1px; font-size: 9pt; letter-spacing: .4px; color: var(--accent); }
  .notes .blk { margin-bottom: 8px; font-size: 9.8pt; }
  .sum { width: 76mm; flex-shrink: 0; }
  .sum table { width: 100%; border-collapse: collapse; }
  .sum td { padding: 3.5px 10px; }
  .sum tr.total td { background: var(--accent); color: #fff; font-weight: 700; font-size: 12.5pt; padding: 8px 10px; }
  .sum tr.total td:first-child { border-radius: 6px 0 0 6px; font-size: 10.5pt; } .sum tr.total td:last-child { border-radius: 0 6px 6px 0; }
  .sum tr.gap td { padding: 2px; }
  .sum tr.wht td { color: var(--muted); }

  /* ลงนาม */
  .signs { display: flex; gap: 12px; margin-top: 22px; break-inside: avoid; }
  .sign { flex: 1; text-align: center; border: 1px solid var(--rule); border-radius: 6px; padding: 8px 8px 9px; font-size: 9.8pt; }
  .sign .space { height: 46px; border-bottom: 1px dotted #8a94a3; margin: 0 14px 5px; }
  .sign .who { white-space: nowrap; overflow: hidden; }
  .sign .role { font-weight: 700; color: var(--accent); }
  .thanks { margin-top: 12px; text-align: center; font-size: 9pt; color: var(--muted); }

  @media print { body { background: #fff; } .bar { display: none; } .page { margin: 0; padding: 0; width: auto; min-height: 0; box-shadow: none; overflow: visible; } }
</style></head>
<body>
${embed ? '' : `<div class="bar"><button onclick="window.print()">พิมพ์ / บันทึกเป็น PDF</button><span>${esc(titleTh)} ${esc(doc.number)}</span></div>`}
<div class="page">
  ${watermark ? `<div class="wm">${watermark}</div>` : ''}
  <div class="head">
    <div class="co">
      ${settings.logo ? `<img src="${esc(settings.logo)}" alt="">` : ''}
      <div>
        <h1>${esc(settings.company_name)}</h1>
        <div class="small">${nl2br(settings.company_address)}</div>
        <div class="small">${settings.company_tax_id ? `เลขประจำตัวผู้เสียภาษี ${esc(settings.company_tax_id)}` : ''}${settings.company_branch ? ` (${esc(settings.company_branch)})` : ''}</div>
        <div class="small">${contactLine}</div>
      </div>
    </div>
    <div class="title"><h2>${titleTh}</h2><div class="en">${titleEn}</div></div>
  </div>
  <div class="rule"></div>

  <div class="meta">
    <div class="cust">
      <div class="label">ลูกค้า</div>
      <strong>${esc(c.name)}</strong>
      <div>${nl2br(c.address)}</div>
      <div>${c.tax_id ? `เลขประจำตัวผู้เสียภาษี ${esc(c.tax_id)}` : ''}${c.branch ? ` (${esc(c.branch)})` : ''}</div>
      <div>${[c.contact && `ผู้ติดต่อ: ${esc(c.contact)}`, c.phone && `โทร. ${esc(c.phone)}`, c.email && esc(c.email)].filter(Boolean).join(' &nbsp;|&nbsp; ')}</div>
    </div>
    <div class="info">
      <div class="k">เลขที่</div><div class="v no">${esc(doc.number)}</div>
      ${info('วันที่', Calc.thDate(doc.date))}
      ${info(DUE_LABEL[doc.type], Calc.thDate(doc.valid_until))}
      ${info('อ้างอิง', esc(doc.source_number))}
      ${info('ผู้ขาย', esc(doc.owner_name))}
    </div>
  </div>

  ${doc.subject ? `<p class="subject"><b>เรื่อง</b> &nbsp;${esc(doc.subject)}</p>` : ''}

  <table class="items">
    <thead><tr>
      <th style="width:10mm">ลำดับ</th><th style="text-align:left">รายการ</th><th style="width:17mm">จำนวน</th><th style="width:16mm">หน่วย</th>
      <th style="width:27mm">ราคา/หน่วย</th>${hasLineDiscount ? '<th style="width:16mm">ส่วนลด</th>' : ''}<th style="width:29mm">จำนวนเงิน</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>

  <div class="foot">
    <div class="notes">
      <div class="baht"><span>จำนวนเงินรวมทั้งสิ้น (ตัวอักษร)</span><b>${Calc.bahtText(t.total)}</b></div>
      ${doc.note ? `<h4>หมายเหตุ</h4><div class="blk">${nl2br(doc.note)}</div>` : ''}
      ${doc.terms ? `<h4>เงื่อนไข</h4><div class="blk">${nl2br(doc.terms)}</div>` : ''}
    </div>
    <div class="sum"><table>
      ${sumRows.map(([k, v]) => `<tr><td>${esc(k)}</td><td class="r">${v}</td></tr>`).join('')}
      <tr class="gap"><td colspan="2"></td></tr>
      <tr class="total"><td>จำนวนเงินรวมทั้งสิ้น</td><td class="r">${m(t.total)}</td></tr>
      ${whtRows}
    </table></div>
  </div>

  <div class="signs">
    ${sign(s1, doc.owner_name, doc.date)}
    ${sign(s2, doc.approver_name, doc.approved_at && doc.approved_at.slice(0, 10))}
    ${sign(s3, '', '')}
  </div>
  ${doc.type === 'QT' ? '<div class="thanks">ขอขอบคุณที่ให้โอกาสเสนอราคา</div>' : ''}
</div>
</body></html>`;
}

module.exports = { renderPrint };
