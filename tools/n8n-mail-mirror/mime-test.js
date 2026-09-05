// Testrahmen fuer die Anhang-Erkennung des Mail-Spiegels.
// Laedt die zu pruefende Implementierung aus mime-impl.js.
const assert = require('node:assert');
const { collectAttachments } = require('./mime-impl.js');

const CRLF = '\r\n';
function mail(lines) { return lines.join(CRLF); }

// --- Fixtures -------------------------------------------------------------

// 1) Flach: Anhang direkt auf oberster Ebene (das konnte V13 bereits)
const flach = mail([
  'Content-Type: multipart/mixed; boundary="AAA"', '',
  '--AAA',
  'Content-Type: text/plain', '', 'Hallo', '',
  '--AAA',
  'Content-Type: application/pdf; name="rechnung.pdf"',
  'Content-Disposition: attachment; filename="rechnung.pdf"',
  'Content-Transfer-Encoding: base64', '',
  Buffer.from('PDF-INHALT').toString('base64'), '',
  '--AAA--', '',
]);

// 2) Verschachtelt: mixed -> alternative + Anhang daneben.
//    Genau diese Form verschickt jedes gaengige Mailprogramm.
const verschachtelt = mail([
  'Content-Type: multipart/mixed; boundary="OUTER"', '',
  '--OUTER',
  'Content-Type: multipart/alternative; boundary="INNER"', '',
  '--INNER',
  'Content-Type: text/plain', '', 'Hallo', '',
  '--INNER',
  'Content-Type: text/html', '', '<p>Hallo</p>', '',
  '--INNER--', '',
  '--OUTER',
  'Content-Type: application/pdf; name="rechnung.pdf"',
  'Content-Disposition: attachment; filename="rechnung.pdf"',
  'Content-Transfer-Encoding: base64', '',
  Buffer.from('PDF-INHALT').toString('base64'), '',
  '--OUTER--', '',
]);

// 3) Anhang tief drin: mixed -> related -> Anhang
const tief = mail([
  'Content-Type: multipart/mixed; boundary="L1"', '',
  '--L1',
  'Content-Type: multipart/related; boundary="L2"', '',
  '--L2',
  'Content-Type: text/html', '', '<p>Text</p>', '',
  '--L2',
  'Content-Type: image/png; name="logo.png"',
  'Content-Disposition: inline; filename="logo.png"',
  'Content-Transfer-Encoding: base64', '',
  Buffer.from('PNG').toString('base64'), '',
  '--L2--', '',
  '--L1--', '',
]);

// 4) quoted-printable statt base64 (V13 ueberspringt das komplett)
const qp = mail([
  'Content-Type: multipart/mixed; boundary="Q"', '',
  '--Q',
  'Content-Type: text/plain', '', 'Text', '',
  '--Q',
  'Content-Type: text/calendar; name="termin.ics"',
  'Content-Disposition: attachment; filename="termin.ics"',
  'Content-Transfer-Encoding: quoted-printable', '',
  'BEGIN:VCALENDAR=0D=0AEND:VCALENDAR', '',
  '--Q--', '',
]);

// 5) Ohne Anhang — es darf nichts erfunden werden
const ohne = mail([
  'Content-Type: text/plain', '', 'Nur Text', '',
]);

// --- Tests ----------------------------------------------------------------

let fehler = 0;
function pruefe(name, fn) {
  try { fn(); console.log('  ok   ' + name); }
  catch (e) { fehler++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

pruefe('flacher Anhang wird gefunden', () => {
  const a = collectAttachments(flach);
  assert.strictEqual(a.length, 1);
  assert.strictEqual(a[0].filename, 'rechnung.pdf');
  assert.strictEqual(a[0].buffer.toString(), 'PDF-INHALT');
});

pruefe('verschachtelter Anhang wird gefunden (mixed -> alternative)', () => {
  const a = collectAttachments(verschachtelt);
  assert.strictEqual(a.length, 1);
  assert.strictEqual(a[0].filename, 'rechnung.pdf');
  assert.strictEqual(a[0].buffer.toString(), 'PDF-INHALT');
});

pruefe('tief verschachtelter Anhang wird gefunden (mixed -> related)', () => {
  const a = collectAttachments(tief);
  assert.strictEqual(a.length, 1);
  assert.strictEqual(a[0].filename, 'logo.png');
});

pruefe('quoted-printable-Anhang wird dekodiert', () => {
  const a = collectAttachments(qp);
  assert.strictEqual(a.length, 1);
  assert.strictEqual(a[0].filename, 'termin.ics');
  assert.ok(a[0].buffer.toString().includes('BEGIN:VCALENDAR'));
});

pruefe('Mail ohne Anhang liefert nichts', () => {
  assert.strictEqual(collectAttachments(ohne).length, 0);
});

pruefe('leere Eingabe stuerzt nicht ab', () => {
  assert.strictEqual(collectAttachments('').length, 0);
  assert.strictEqual(collectAttachments(null).length, 0);
});

// --- Nachtrag: kodierte Dateinamen (RFC 2047 / 2231) ----------------------
// Aufgefallen am 05.09.2026 im Livebetrieb: Die BIKEpoint-Rechnung landete
// als "=-iso-8859-1-Q-Walter_Sch=F6nenbr=F6cher_-_Verkauf-Rechnung.pdf-="
// im Vault — der Anhang war gerettet, der Name aber unbrauchbar.
const rfc2047 = mail([
  'Content-Type: multipart/mixed; boundary="R"', '',
  '--R',
  'Content-Type: text/plain', '', 'Text', '',
  '--R',
  'Content-Type: application/pdf; name="=?iso-8859-1?Q?Walter_Sch=F6nenbr=F6cher_-_Verkauf-Rechnung.pdf?="',
  'Content-Disposition: attachment; filename="=?iso-8859-1?Q?Walter_Sch=F6nenbr=F6cher_-_Verkauf-Rechnung.pdf?="',
  'Content-Transfer-Encoding: base64', '',
  Buffer.from('PDF').toString('base64'), '',
  '--R--', '',
]);

const rfc2047b64 = mail([
  'Content-Type: multipart/mixed; boundary="B"', '',
  '--B',
  'Content-Type: text/plain', '', 'Text', '',
  '--B',
  'Content-Type: application/pdf',
  'Content-Disposition: attachment; filename="=?UTF-8?B?' + Buffer.from('Rechnung Ümlaut.pdf','utf8').toString('base64') + '?="',
  'Content-Transfer-Encoding: base64', '',
  Buffer.from('PDF').toString('base64'), '',
  '--B--', '',
]);

pruefe('RFC-2047 Q-kodierter Dateiname wird dekodiert', () => {
  const a = collectAttachments(rfc2047);
  assert.strictEqual(a.length, 1);
  assert.strictEqual(a[0].filename, 'Walter Schönenbröcher - Verkauf-Rechnung.pdf');
});

pruefe('RFC-2047 B-kodierter Dateiname wird dekodiert', () => {
  const a = collectAttachments(rfc2047b64);
  assert.strictEqual(a.length, 1);
  assert.strictEqual(a[0].filename, 'Rechnung Ümlaut.pdf');
});

pruefe('unkodierter Dateiname bleibt unveraendert', () => {
  const a = collectAttachments(flach);
  assert.strictEqual(a[0].filename, 'rechnung.pdf');
});

console.log(fehler === 0 ? '\nAlle Tests gruen.' : `\n${fehler} Test(s) rot.`);
process.exit(fehler === 0 ? 0 : 1);
