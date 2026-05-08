import fs from 'fs';
import path from 'path';

const enDir = 'ui/src/locales/en';
const deDir = 'ui/src/locales/de';

function readJSON(p) {
  if (!fs.existsSync(p)) return {};
  let s = fs.readFileSync(p, 'utf8');
  if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
  return JSON.parse(s);
}

function setNested(obj, dottedKey, value) {
  const parts = dottedKey.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (cur[k] === undefined || cur[k] === null || typeof cur[k] !== 'object' || Array.isArray(cur[k])) {
      cur[k] = {};
    }
    cur = cur[k];
  }
  cur[parts[parts.length - 1]] = value;
}

function flatten(obj, prefix = '') {
  const out = {};
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    const key = prefix ? prefix + '.' + k : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      Object.assign(out, flatten(v, key));
    } else {
      out[key] = v;
    }
  }
  return out;
}

// Reorder DE keys to match EN structure (helps keep diffs clean)
function reorderToMatchTemplate(template, source) {
  if (template === null || typeof template !== 'object' || Array.isArray(template)) {
    return source;
  }
  if (source === null || typeof source !== 'object' || Array.isArray(source)) {
    return source;
  }
  const out = {};
  // First, pick keys in template order
  for (const k of Object.keys(template)) {
    if (k in source) {
      out[k] = reorderToMatchTemplate(template[k], source[k]);
    }
  }
  // Then, append any extra keys present in source but not in template (shouldn't happen for parity, but keep them)
  for (const k of Object.keys(source)) {
    if (!(k in out)) {
      out[k] = source[k];
    }
  }
  return out;
}

const translationsFile = process.argv[2] || 'de_translations.json';
const translations = readJSON(translationsFile);

const filesToProcess = Object.keys(translations);
let totalAdded = 0;

for (const f of filesToProcess) {
  const dePath = path.join(deDir, f);
  const enPath = path.join(enDir, f);
  const deObj = readJSON(dePath);
  const enObj = readJSON(enPath);
  const enFlat = flatten(enObj);
  const deFlatBefore = flatten(deObj);

  const map = translations[f];
  let added = 0;
  for (const [k, v] of Object.entries(map)) {
    if (k in deFlatBefore) {
      console.warn(`SKIP existing key ${f}:${k}`);
      continue;
    }
    if (!(k in enFlat)) {
      console.warn(`WARN: ${f}:${k} not in EN — will still add for safety`);
    }
    setNested(deObj, k, v);
    added++;
  }
  totalAdded += added;

  // Reorder keys to match EN structure (positional parity for cleaner diffs)
  const reordered = reorderToMatchTemplate(enObj, deObj);

  fs.writeFileSync(dePath, JSON.stringify(reordered, null, 2) + '\n', 'utf8');
  console.log(`${f}: added ${added} keys`);
}
console.log('TOTAL added:', totalAdded);
