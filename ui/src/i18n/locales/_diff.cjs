const fs = require('fs');
const path = require('path');

const enPath = path.join(__dirname, 'en.json');
const zhPath = path.join(__dirname, 'zh-CN.json');

function flatKeys(obj, prefix = '') {
    const result = [];
    for (const [key, value] of Object.entries(obj)) {
        const fullKey = prefix ? `${prefix}.${key}` : key;
        if (typeof value === 'string') {
            result.push(fullKey);
        } else if (value !== null && typeof value === 'object') {
            result.push(...flatKeys(value, fullKey));
        }
    }
    return result;
}

const en = JSON.parse(fs.readFileSync(enPath, 'utf-8'));
const zh = JSON.parse(fs.readFileSync(zhPath, 'utf-8'));

const enKeys = new Set(flatKeys(en));
const zhKeys = new Set(flatKeys(zh));

console.log(`en.json keys: ${enKeys.size}`);
console.log(`zh-CN.json keys: ${zhKeys.size}`);

const onlyInEn = [...enKeys].filter(k => !zhKeys.has(k));
const onlyInZh = [...zhKeys].filter(k => !enKeys.has(k));

console.log(`\n=== Keys in en.json but MISSING in zh-CN.json (${onlyInEn.length}) ===`);
for (const k of onlyInEn.sort()) console.log(`  ${k}`);

console.log(`\n=== Keys in zh-CN.json but NOT in en.json (orphans) (${onlyInZh.length}) ===`);
for (const k of onlyInZh.sort()) console.log(`  ${k}`);
