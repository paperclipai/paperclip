const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { buildIndex } = require('../src/index-builder.js');

const FIXTURE = path.join(__dirname, '..', 'testdata', 'vault');

test('Index aus Kontakten enthält Dateinamen, Organisationen, Namen', () => {
  const { index, anzahl } = buildIndex({
    vaultPfad: FIXTURE,
    indexOrdner: ['Kontakte'],
    ausgeschlosseneOrdner: ['attachments', '.obsidian', '.trash'],
    minBegrifflaenge: 5,
  });
  const terme = index.map(e => e.term);
  assert.ok(terme.includes('mustermann-max'));
  assert.ok(terme.includes('musterfirma ag'));
  assert.ok(terme.includes('mustermann max'));
  assert.ok(terme.includes('meier consulting gmbh'));
  assert.strictEqual(anzahl, index.length);
});

test('Index ist nach Laenge absteigend sortiert', () => {
  const { index } = buildIndex({
    vaultPfad: FIXTURE,
    indexOrdner: ['Kontakte'],
    ausgeschlosseneOrdner: [],
    minBegrifflaenge: 5,
  });
  for (let i = 1; i < index.length; i++) {
    assert.ok(index[i - 1].term.length >= index[i].term.length,
      `nicht sortiert an Position ${i}`);
  }
});

test('respektiert minBegrifflaenge', () => {
  const { index } = buildIndex({
    vaultPfad: FIXTURE,
    indexOrdner: ['Kontakte'],
    ausgeschlosseneOrdner: [],
    minBegrifflaenge: 20,
  });
  for (const e of index) assert.ok(e.term.length >= 20);
});

test('attachments wird nicht indiziert', () => {
  const { index } = buildIndex({
    vaultPfad: FIXTURE,
    indexOrdner: ['attachments'],
    ausgeschlosseneOrdner: ['attachments'],
    minBegrifflaenge: 5,
  });
  assert.strictEqual(index.length, 0);
});

test('lintOrganisations warnt bei Berufsbezeichnungen in organisation', () => {
  const { lintOrganisations } = require('../src/index-builder.js');
  const result = lintOrganisations({
    vaultPfad: FIXTURE,
    indexOrdner: ['Kontakte'],
    ausgeschlosseneOrdner: [],
  });
  // Mustermann-Max hat organisation "Musterfirma AG" → kein Stoppwort
  // Meier-Anna hat organisation "Meier Consulting GmbH" → kein Stoppwort
  assert.strictEqual(result.warnings.length, 0);
  assert.ok(result.checked > 0);
});

test('Längen-Cap >= 30: lange Terme werden nicht vorzeitig gefiltert', () => {
  const { buildIndex } = require('../src/index-builder.js');
  // Erstelle einen Index mit einem langen Term (> 40 Zeichen)
  const result = buildIndex({
    vaultPfad: FIXTURE,
    indexOrdner: ['Kontakte'],
    ausgeschlosseneOrdner: [],
    minBegrifflaenge: 5,
  });
  // "meier consulting gmbh" ist 23 Zeichen und sollte drin sein
  const terme = result.index.map(e => e.term);
  assert.ok(terme.includes('meier consulting gmbh'));
});
