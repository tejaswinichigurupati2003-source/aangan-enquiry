// Minimal YAML subset parser (maps, block lists, inline lists/maps, scalars, comments).
// Enough for config.yaml; deliberately not a general YAML implementation.

function stripComment(line) {
  let q = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

function splitTop(s, sep = ',') {
  const out = []; let depth = 0; let q = null; let cur = '';
  for (const c of s) {
    if (q) { cur += c; if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === '[' || c === '{') depth++;
    if (c === ']' || c === '}') depth--;
    if (c === sep && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function scalar(s) {
  s = s.trim();
  if (s === '' || s === '~' || s === 'null') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (s.startsWith('[') && s.endsWith(']')) return splitTop(s.slice(1, -1)).map(scalar);
  if (s.startsWith('{') && s.endsWith('}')) {
    const o = {};
    for (const part of splitTop(s.slice(1, -1))) {
      const i = part.indexOf(':');
      o[part.slice(0, i).trim()] = scalar(part.slice(i + 1));
    }
    return o;
  }
  return s;
}

export function parseYaml(text) {
  const lines = text.split(/\r?\n/)
    .map((raw) => ({ indent: raw.match(/^ */)[0].length, text: stripComment(raw).trim() }))
    .filter((l) => l.text);
  let i = 0;

  function parseBlock(indent) {
    if (lines[i].text.startsWith('- ')) {
      const arr = [];
      while (i < lines.length && lines[i].indent === indent && lines[i].text.startsWith('- ')) {
        arr.push(scalar(lines[i].text.slice(2)));
        i++;
      }
      return arr;
    }
    const obj = {};
    while (i < lines.length && lines[i].indent === indent) {
      const t = lines[i].text;
      const idx = t.indexOf(':');
      if (idx < 0) throw new Error(`yaml: expected "key: value" at "${t}"`);
      const key = t.slice(0, idx).trim();
      const rest = t.slice(idx + 1).trim();
      i++;
      if (rest === '') {
        if (i < lines.length && lines[i].indent > indent) obj[key] = parseBlock(lines[i].indent);
        else obj[key] = null;
      } else obj[key] = scalar(rest);
    }
    return obj;
  }
  return lines.length ? parseBlock(lines[0].indent) : {};
}
