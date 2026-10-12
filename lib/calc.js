// สูตรคำนวณที่ใช้ร่วมกันทั้งฝั่งเซิร์ฟเวอร์และหน้าเว็บ
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Calc = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const num = v => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  const round2 = n => Math.round((num(n) + Number.EPSILON) * 100) / 100;
  const clamp = (n, lo, hi) => Math.min(Math.max(num(n), lo), hi);

  function lineAmount(it) {
    return round2(num(it.qty) * num(it.price) * (1 - clamp(it.discount, 0, 100) / 100));
  }

  function totals(doc) {
    const subtotal = round2((doc.items || []).reduce((s, it) => s + lineAmount(it), 0));
    const rawDiscount = doc.discount_type === 'percent'
      ? subtotal * clamp(doc.discount_value, 0, 100) / 100
      : num(doc.discount_value);
    const discount_amount = round2(clamp(rawDiscount, 0, subtotal));
    const after = round2(subtotal - discount_amount);
    const rate = doc.vat_mode === 'none' ? 0 : clamp(doc.vat_rate, 0, 100);
    let net, vat_amount, total;
    if (doc.vat_mode === 'inclusive') {
      total = after;
      net = round2(total * 100 / (100 + rate));
      vat_amount = round2(total - net);
    } else {
      net = after;
      vat_amount = round2(net * rate / 100);
      total = round2(net + vat_amount);
    }
    const wht_amount = round2(net * clamp(doc.wht_rate, 0, 100) / 100);
    return { subtotal, discount_amount, net, vat_amount, total, wht_amount, payable: round2(total - wht_amount) };
  }

  function money(n) {
    return round2(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  // 2026-10-12 -> 12/10/2569
  function thDate(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
    return m ? `${m[3]}/${m[2]}/${Number(m[1]) + 543}` : '';
  }

  const DIGITS = ['ศูนย์', 'หนึ่ง', 'สอง', 'สาม', 'สี่', 'ห้า', 'หก', 'เจ็ด', 'แปด', 'เก้า'];
  const PLACES = ['', 'สิบ', 'ร้อย', 'พัน', 'หมื่น', 'แสน'];

  function readInt(n) {
    if (n >= 1000000) {
      const rest = n % 1000000;
      return readInt(Math.floor(n / 1000000)) + 'ล้าน' + (rest ? readGroup(rest, true) : '');
    }
    return readGroup(n, false);
  }

  function readGroup(n, hasHigher) {
    const s = String(n);
    let out = '';
    for (let i = 0; i < s.length; i++) {
      const d = Number(s[i]);
      const place = s.length - 1 - i;
      if (d === 0) continue;
      if (place === 0 && d === 1 && (n > 1 || hasHigher)) out += 'เอ็ด';
      else if (place === 1 && d === 1) out += 'สิบ';
      else if (place === 1 && d === 2) out += 'ยี่สิบ';
      else out += DIGITS[d] + PLACES[place];
    }
    return out;
  }

  function bahtText(amount) {
    const v = round2(Math.abs(num(amount)));
    const baht = Math.floor(v);
    const satang = Math.round((v - baht) * 100);
    if (baht === 0 && satang === 0) return 'ศูนย์บาทถ้วน';
    let out = num(amount) < 0 ? 'ลบ' : '';
    if (baht > 0) out += readInt(baht) + 'บาท';
    out += satang > 0 ? readInt(satang) + 'สตางค์' : 'ถ้วน';
    return out;
  }

  return { num, round2, lineAmount, totals, money, thDate, bahtText };
});
