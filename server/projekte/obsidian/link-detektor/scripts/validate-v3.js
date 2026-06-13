#!/usr/bin/env node
/**
 * Validierungsskript für Link-Detektor V3 (WHI-307)
 * Baut den Index mit dem echten Vault, prüft Stoppwörter & Längen-Cap,
 * und gibt 5 manuelle Stichproben aus.
 */

import { buildIndex, lintOrganisations } from '../src/index-builder.js';
import path from 'path';

const VAULT = '/Users/walterschoenenbroecher.de/Obsidian/WHITESTAG-Vault';
const INDEX_ORDNER = ['Kontakte'];
const AUSGESCHLOSSEN = ['attachments', '.obsidian', '.trash', 'Analysen', 'copilot'];

console.log('=== Link-Detektor V3 Validierung ===\n');

// 1. Index aufbauen
console.log('[1/4] Baue Index...');
const { index, anzahl, geblockt } = buildIndex({
  vaultPfad: VAULT,
  indexOrdner: INDEX_ORDNER,
  ausgeschlosseneOrdner: AUSGESCHLOSSEN,
  minBegrifflaenge: 5,
});

console.log(`    Index-Terme: ${anzahl}`);
console.log(`    Geblockt — Stoppwörter: ${geblockt.stoppwort}, Duplikate: ${geblockt.duplikat}, zuKurz: ${geblockt.zuKurz}, Frequenz: ${geblockt.frequenz}\n`);

// 2. Prüfen ob Berufsbezeichnungen korrekt gefiltert sind
console.log('[2/4] Prüfe Stoppwort-Filterung (Berufsbezeichnungen)...');
const berufe = ['geschäftsführer', 'projektmanagerin', 'cto', 'ceo', 'entwickler', 'marketing manager'];
const treffer = [];
for (const b of berufe) {
  const found = index.find(e => e.term === b);
  if (!found) treffer.push(`✓ "${b}" korrekt gefiltert`);
  else treffer.push(`✗ "${b}" NICHT gefiltert → ${found.linkZiel}`);
}
console.log(treffer.join('\n') + '\n');

// 3. Prüfen ob lange Firmennamen noch drin sind (Längen-Cap >= 30)
console.log('[3/4] Prüfe Längen-Cap (lange Begriffe)...');
const langeBegriffe = index.filter(e => e.term.length > 25);
console.log(`    Terme > 25 Zeichen: ${langeBegriffe.length}`);
if (langeBegriffe.length > 0) {
  console.log('    Beispiele:');
  for (const t of langeBegriffe.slice(0, 5)) {
    console.log(`      - "${t.term}" (${t.term.length} Zeichen) → ${t.linkZiel}`);
  }
} else {
  console.log('    (keine sehr langen Terme im Index — alle ≤25 Zeichen)');
}

// 4. Lint-Check für organisation-Felder
console.log('\n[4/4] Prüfe lintOrganisations...');
const lint = lintOrganisations({ vaultPfad: VAULT, indexOrdner: INDEX_ORDNER, ausgeschlosseneOrdner: AUSGESCHLOSSEN });
console.log(`    Geprüfte Dateien: ${lint.checked}`);
console.log(`    Warnungen (Berufsbezeichnungen in organisation): ${lint.warnings.length}`);
if (lint.warnings.length > 0) {
  console.log('    Beispiele:');
  for (const w of lint.warnings.slice(0, 5)) {
    console.log(`      - ${w.datei}: "${w.organisation}" → ${w.begründung}`);
  }
}

// 5. Manuelle Stichproben (5 Dateien)
console.log('\n=== Manuelle Stichproben ===');
const probeDateien = [
  'Max Mustermann',
  'Anna Meier',
  'Thomas Schmidt',
  'Julia Weber',
  'Michael Fischer'
];

for (const name of probeDateien) {
  const entry = index.find(e => e.linkZiel === name.toLowerCase().replace(' ', '-'));
  if (entry) {
    console.log(`\n📄 ${name}:`);
    console.log(`   Index-Term: "${entry.term}" (${entry.term.length} Zeichen)`);
    console.log(`   Original: "${entry.originalBegriff}"`);
  } else {
    console.log(`\n📄 ${name}: nicht im Index (evtl. zu kurz oder gefiltert)`);
  }
}

console.log('\n=== Validierung abgeschlossen ===');
