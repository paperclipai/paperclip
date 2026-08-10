// test_build_log_line.mjs  —  node --test test_build_log_line.mjs
//
// Treibt den ECHTEN, gepatchten "Build Log Line"-Code direkt an, statt eine
// JS-Nachbildung der sigStatus/sigPart-Logik zu mocken. Der Code kommt von
// emit_build_log_line_v19.py, das denselben patch_relay.py-Patch
// (patch_build_log_line_status_marker) aufruft, der auch beim echten
// "--apply" auf den Workflow angewendet wird — Single Source of Truth.
//
// Deckt genau den Fall ab, der sich nicht direkt provozieren laesst: der
// Aufrufrahmen von "Attach Signature" bricht ab (z.B. require('fs') wirft),
// n8n reicht bei onError=continueRegularOutput die UNVERAENDERTE Eingabe
// durch -> das Item hat gar kein __signaturStatus-Feld. Wir bilden das nach,
// indem wir $('Attach Signature').first().json ohne das Feld uebergeben, und
// pruefen, dass "Build Log Line" das erkennt (statt es wie einen normalen,
// fehlerfreien Versand zu behandeln).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HIER = path.dirname(fileURLToPath(import.meta.url));

function v19Code() {
  const out = execFileSync(
    '/usr/bin/python3', ['emit_build_log_line_v19.py'],
    { cwd: HIER, encoding: 'utf8' },
  );
  return JSON.parse(out);
}

// Baut die minimale n8n-Laufzeitumgebung nach, die dieser Code-Node
// braucht: $('Node') und $input. Der Code selbst ist n8n-Code-Node-Stil
// (bare "return" auf oberster Ebene) -- new Function(...) wrappt ihn exakt
// so wie n8n es intern als Funktionskoerper tut.
function fuehreAus(code, { req, smtp, attach }) {
  const fn = new Function('$', '$input', code);
  const $ = (name) => {
    if (name === 'Validate Request') return { first: () => ({ json: req }) };
    if (name === 'Attach Signature') return { first: () => ({ json: attach }) };
    throw new Error('Test-Stub: unbekannter Node ' + name);
  };
  const $input = { first: () => ({ json: smtp }) };
  return fn($, $input)[0].json.logLine;
}

const req = { from: 'cto@whitestag.ai', to: 'ws@whitestag.ai', cc: '', subject: 'Test' };
const smtp = { messageId: '<abc@x>' };
const ZEITSTEMPEL_RE = '\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}';

test('(a) normaler Marker (signiert) -> Zeile byte-identisch zum Altformat, kein Warnsegment', () => {
  const code = v19Code();
  const line = fuehreAus(code, { req, smtp, attach: { __signaturStatus: 'signiert' } });
  const erwartet = new RegExp(
    `^- \\*\\*${ZEITSTEMPEL_RE}\\*\\* \`cto@whitestag\\.ai\` → \`ws@whitestag\\.ai\` · `
    + `\\*Test\\* · msgId \`<abc@x>\`\\n$`,
  );
  assert.match(line, erwartet);
  assert.ok(!line.includes('⚠️'));
});

test('bewusst uebersprungen (uebersprungen_keine_signatur) -> ebenfalls byte-identisch, kein Warnsegment', () => {
  const code = v19Code();
  const line = fuehreAus(code, { req, smtp, attach: { __signaturStatus: 'uebersprungen_keine_signatur' } });
  assert.ok(!line.includes('⚠️'));
  assert.ok(line.endsWith('msgId `<abc@x>`\n'));
});

test('(b) Fehler-Marker (fehler) -> bestehendes V18-Segment SIGNATUR FEHLGESCHLAGEN bleibt', () => {
  const code = v19Code();
  const line = fuehreAus(code, {
    req, smtp,
    attach: { __signaturStatus: 'fehler', __signaturFehler: 'ENOENT: bereich-de.html' },
  });
  assert.ok(line.includes('⚠️ SIGNATUR FEHLGESCHLAGEN: ENOENT: bereich-de.html'));
  assert.ok(!line.includes('SIGNATUR-MARKER FEHLT'));
});

test('(c) fehlender Marker (Aufrufrahmen-Abbruch nachgebildet) -> eigenes Warnsegment SIGNATUR-MARKER FEHLT', () => {
  const code = v19Code();
  // Bildet exakt den Finding-Fall nach: onError=continueRegularOutput reicht
  // die unveraenderte Eingabe durch -- kein __signaturStatus, kein
  // __signaturFehler, weil signiere() nie lief.
  const line = fuehreAus(code, { req, smtp, attach: { from: 'cto@whitestag.ai' } });
  assert.ok(line.includes('⚠️ SIGNATUR-MARKER FEHLT'));
  assert.ok(!line.includes('SIGNATUR FEHLGESCHLAGEN'));
});

test('$("Attach Signature") wirft selbst (Knoten nie gelaufen) -> ebenfalls SIGNATUR-MARKER FEHLT, kein Crash', () => {
  const code = v19Code();
  const fn = new Function('$', '$input', code);
  const $ = (name) => {
    if (name === 'Validate Request') return { first: () => ({ json: req }) };
    if (name === 'Attach Signature') { throw new Error('kein Vorgaenger-Item'); }
    throw new Error('Test-Stub: unbekannter Node ' + name);
  };
  const $input = { first: () => ({ json: smtp }) };
  const line = fn($, $input)[0].json.logLine;
  assert.ok(line.includes('⚠️ SIGNATUR-MARKER FEHLT'));
});
