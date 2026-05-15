#!/usr/bin/env node
/**
 * Sync i18n translations from en.json source of truth.
 * Reads GOOGLE_API_KEY from .env file (never committed).
 * Usage: node scripts/sync-i18n.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const LANG_DIR = path.join(ROOT, "ui", "src", "i18n", "locales");

// Load GOOGLE_API_KEY from .env
function loadEnv() {
  const envPath = path.join(ROOT, ".env");
  if (!fs.existsSync(envPath)) return {};
  const raw = fs.readFileSync(envPath, "utf-8");
  const vars = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_]+)=(.*)$/);
    if (m) vars[m[1]] = m[2];
  }
  return vars;
}

const ENV = loadEnv();
const API_KEY = ENV.GOOGLE_API_KEY;

// Target languages: code -> Google Translate target code
const TARGET_LANGUAGES = {
  es: "es",
  pt: "pt",
  de: "de",
  fr: "fr",
  ja: "ja",
  zh: "zh-CN",
};

// Flatten nested object to dot-notation keys
function flatten(obj, prefix = "") {
  return Object.entries(obj).reduce((acc, [key, val]) => {
    const newKey = prefix ? `${prefix}.${key}` : key;
    if (val && typeof val === "object" && !Array.isArray(val)) {
      Object.assign(acc, flatten(val, newKey));
    } else {
      acc[newKey] = String(val);
    }
    return acc;
  }, {});
}

// Rebuild nested object from flat translations using template structure
function rebuildFromTemplate(template, flatTranslations, prefix = "") {
  const result = {};
  for (const [key, val] of Object.entries(template)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (val && typeof val === "object" && !Array.isArray(val)) {
      result[key] = rebuildFromTemplate(val, flatTranslations, fullKey);
    } else {
      result[key] = flatTranslations[fullKey] ?? val;
    }
  }
  return result;
}

// Deep sort object keys alphabetically
function orderKeysDeep(obj) {
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    return Object.keys(obj)
      .sort()
      .reduce((acc, key) => {
        acc[key] = orderKeysDeep(obj[key]);
        return acc;
      }, {});
  }
  return obj;
}

async function translateBatch(texts, targetLang) {
  const url = `https://translation.googleapis.com/language/translate/v2?key=${API_KEY}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ q: texts, source: "en", target: targetLang, format: "text" }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`HTTP ${res.status}: ${err}`);
  }
  const data = await res.json();
  return data.data.translations.map((t) => t.translatedText);
}

async function syncLanguage(langCode, googleLangCode, flatEn, orderedEn) {
  const langPath = path.join(LANG_DIR, `${langCode}.json`);

  let existingFlat = {};
  if (fs.existsSync(langPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(langPath, "utf-8"));
      existingFlat = flatten(raw);
    } catch (e) {
      console.log(`  ⚠️ Could not read ${langCode}.json, creating new`);
    }
  }

  const missingKeys = Object.keys(flatEn).filter((k) => !(k in existingFlat));

  if (missingKeys.length === 0) {
    console.log(`✅ [${langCode.toUpperCase()}] No missing translations.`);
    const rebuilt = rebuildFromTemplate(orderedEn, existingFlat);
    fs.writeFileSync(langPath, JSON.stringify(rebuilt, null, 2), "utf-8");
    return;
  }

  console.log(`\n🔄 [${langCode.toUpperCase()}] Translating ${missingKeys.length} keys...`);

  const BATCH_SIZE = 100;
  let translated = 0;

  for (let i = 0; i < missingKeys.length; i += BATCH_SIZE) {
    const batchKeys = missingKeys.slice(i, i + BATCH_SIZE);
    const batchTexts = batchKeys.map((k) => flatEn[k]);

    try {
      const translations = await translateBatch(batchTexts, googleLangCode);
      batchKeys.forEach((key, idx) => {
        existingFlat[key] = translations[idx];
        translated++;
      });
      console.log(`  ✅ Batch ${Math.floor(i / BATCH_SIZE) + 1}: ${batchKeys.length} keys`);
    } catch (err) {
      console.error(`  ❌ Error batch ${Math.floor(i / BATCH_SIZE) + 1}:`, err.message);
    }
  }

  const rebuilt = rebuildFromTemplate(orderedEn, existingFlat);
  fs.writeFileSync(langPath, JSON.stringify(rebuilt, null, 2), "utf-8");
  console.log(`💾 [${langCode.toUpperCase()}] Saved ${langCode}.json (${translated} translated).`);
}

async function main() {
  if (!API_KEY) {
    console.error("❌ GOOGLE_API_KEY not found in .env");
    console.log("   Add it to .env: GOOGLE_API_KEY=your-key");
    process.exit(1);
  }

  if (!fs.existsSync(LANG_DIR)) {
    fs.mkdirSync(LANG_DIR, { recursive: true });
  }

  const enPath = path.join(LANG_DIR, "en.json");
  if (!fs.existsSync(enPath)) {
    console.error("❌ en.json not found at", enPath);
    process.exit(1);
  }

  console.log("📖 Reading en.json...");
  const rawEn = JSON.parse(fs.readFileSync(enPath, "utf-8"));
  const orderedEn = orderKeysDeep(rawEn);
  fs.writeFileSync(enPath, JSON.stringify(orderedEn, null, 2), "utf-8");
  console.log("✅ en.json sorted.");

  const flatEn = flatten(orderedEn);
  console.log(`📊 Total keys in en: ${Object.keys(flatEn).length}`);

  const allLangs = ["en", ...Object.keys(TARGET_LANGUAGES)];

  for (const [langCode, googleLangCode] of Object.entries(TARGET_LANGUAGES)) {
    await syncLanguage(langCode, googleLangCode, flatEn, orderedEn);
  }

  console.log(`📝 Available locales: ${allLangs.join(", ")}`);
  console.log("\n🎉 Sync complete!");
  console.log(`   Languages: ${allLangs.join(", ")}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
