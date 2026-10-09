/** Normalise an Indian caller number to E.164 (+91XXXXXXXXXX). Returns null if unusable/withheld. */
export function normalizePhone(input) {
  if (input == null) return null;
  let d = String(input).replace(/[^\d+]/g, '');
  if (d.startsWith('+')) d = d.slice(1);
  d = d.replace(/^00/, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  if (!/^\d{10}$/.test(d)) return null;
  return `+91${d}`;
}

/** Find a spoken/typed phone number inside free text. */
export function extractPhone(text) {
  const m = String(text ?? '').match(/(?:\+?91[\s-]?|0)?(?:\d[\s-]?){9}\d/);
  return m ? normalizePhone(m[0]) : null;
}

/** "+91 98xxx xxxxx" for humans */
export function displayPhone(e164) {
  if (!e164) return 'number withheld';
  const d = e164.replace('+91', '');
  return `+91 ${d.slice(0, 5)} ${d.slice(5)}`;
}
