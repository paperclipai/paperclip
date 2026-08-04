import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { signiere, ABSENDER } = require(path.join(HIER, 'relay_signatur.js'));

const lies = (p) => fs.readFileSync(p, 'utf8');
const basis = (extra = {}) => ({
  from: 'cto@whitestag.ai',
  to: 'ws@whitestag.ai',
  subject: 'Test',
  html: '<p>Inhalt</p>',
  text: 'Inhalt',
  attachments: [],
  ...extra,
});

test('alle zehn whitestag-Absender sind hinterlegt', () => {
  const erwartet = ['ceo', 'cmo', 'cto', 'cpo', 'cro', 'creative', 'dpo',
                    'webdesign', 'health', 'office'];
  for (const k of erwartet) {
    assert.ok(ABSENDER[`${k}@whitestag.ai`], k);
  }
});

test('haengt Signatur an das HTML an', () => {
  const j = signiere(basis(), lies);
  assert.ok(j.html.includes('i.A. CTO'));
  assert.ok(j.html.includes('ws@whitestag.ai'));
  assert.ok(j.html.indexOf('<p>Inhalt</p>') < j.html.indexOf('i.A. CTO'));
});

test('haengt eine Textfassung ohne Logo an den Text an', () => {
  const j = signiere(basis(), lies);
  assert.ok(j.text.includes('i.A. CTO'));
  assert.ok(j.text.includes('übernimmt keine Haftung'));
  assert.ok(!j.text.includes('base64'));
});

test('waehlt den Bereich aus dem Feld bereich', () => {
  const j = signiere(basis({ bereich: 'film' }), lies);
  assert.ok(j.html.includes('ws@whitestag.film'));
  assert.ok(j.html.includes('VR Filmproduktion'));
});

test('faellt ohne bereich auf ai zurueck', () => {
  const j = signiere(basis(), lies);
  assert.ok(j.html.includes('ws@whitestag.ai'));
});

test('faellt bei unbekanntem bereich auf ai zurueck', () => {
  const j = signiere(basis({ bereich: 'quatsch' }), lies);
  assert.ok(j.html.includes('ws@whitestag.ai'));
});

test('sorbart ist kein gueltiger Bereich mehr', () => {
  const j = signiere(basis({ bereich: 'sorbart' }), lies);
  assert.ok(j.html.includes('ws@whitestag.ai'));
  assert.ok(!j.html.includes('sorbART'));
});

test('signatur none laesst alles unveraendert', () => {
  const j = signiere(basis({ signatur: 'none' }), lies);
  assert.equal(j.html, '<p>Inhalt</p>');
  assert.equal(j.attachments.length, 0);
});

test('unbekannter Absender wird nicht signiert', () => {
  const j = signiere(basis({ from: 'paperclip@clara-werden.de' }), lies);
  assert.equal(j.html, '<p>Inhalt</p>');
  assert.equal(j.attachments.length, 0);
});

test('KRITISCH: Logo landet hinter bestehenden Anhaengen', () => {
  const j = signiere(basis({
    attachments: [
      { filename: 'a.xlsx', content: 'AAA', mimeType: 'application/vnd.ms-excel' },
      { filename: 'b.pdf', content: 'BBB', mimeType: 'application/pdf' },
    ],
  }), lies);
  assert.equal(j.attachments.length, 3);
  assert.equal(j.attachments[0].filename, 'a.xlsx');
  assert.equal(j.attachments[1].filename, 'b.pdf');
  assert.equal(j.attachments[2].cid, 'attachment_2');
  assert.ok(j.html.includes('src="cid:attachment_2"'));
  assert.ok(!j.html.includes('data:image/png;base64,'));
});

test('reine Textmail bekommt keinen Logo-Anhang', () => {
  const j = signiere(basis({ html: undefined }), lies);
  assert.ok(j.text.includes('i.A. CTO'));
  assert.equal(j.attachments.length, 0);
});

test('fehlender Baustein blockiert den Versand nicht', () => {
  const kaputt = () => { throw new Error('ENOENT'); };
  const j = signiere(basis(), kaputt);
  assert.equal(j.html, '<p>Inhalt</p>');
  assert.equal(j.attachments.length, 0);
  assert.ok(j.__signaturFehler.includes('ENOENT'));
});

test('office bekommt Lunas Bezeichnung', () => {
  const j = signiere(basis({ from: 'office@whitestag.ai' }), lies);
  assert.ok(j.html.includes('i.A. Luna'));
  assert.ok(j.html.includes('KI-Assistentin'));
});
