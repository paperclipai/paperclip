#!/usr/bin/env node
// Hilfsprozess fuer test_cross_impl_signatur.py (Finding 2 des
// Abschluss-Reviews: signatur.py und relay_signatur.js muessen byte-identische
// Signatur-HTML erzeugen; das war bisher nur ein manueller Abgleich).
//
// Ruft die echte Produktionsfunktion signiere() aus relay_signatur.js auf,
// leitet den Dateizugriff aber auf ein beliebiges Verzeichnis um (per
// Basename statt ueber die hartkodierte BAUSTEIN_VERZEICHNIS-Konstante) --
// genau dafuer nimmt signiere() den leseDatei-Parameter entgegen. So liest
// dieser Test dieselben Repo-Bausteine wie signatur.py, statt wie
// test_relay_signatur.mjs den Live-Pfad zu treffen. Damit deckt der
// Abgleich echte Bereiche.json/vorlage.html-Aenderungen VOR dem Deploy auf.
//
// Usage: node equiv_probe.mjs <bereich> <name> <rolle> <bausteinVerzeichnis>
// stdout (Erfolg): {"hinweis": "...", "html": "...", "attachments": [...]}
// stderr + exit!=0 (Fehler): kein stdout-JSON, wird vom Python-Test als
// harter Fehlschlag behandelt (nicht als leises Uebereinstimmen).

import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HIER = path.dirname(fileURLToPath(import.meta.url));
const { signiere, hinweisFuer, ABSENDER } = require(path.join(HIER, 'relay_signatur.js'));

const [, , bereich, name, rolle, bausteinVerzeichnis] = process.argv;
if (!bereich || !name || !rolle || !bausteinVerzeichnis) {
  process.stderr.write(
    'Usage: equiv_probe.mjs <bereich> <name> <rolle> <bausteinVerzeichnis>\n');
  process.exit(2);
}

// Kein Eintrag aus der echten Allowlist -- eigene Absenderadresse, die nur
// fuer die Dauer dieses Prozesses in die (In-Memory-Kopie der) ABSENDER-Map
// eingehaengt wird. Betrifft nie den laufenden Relay: eigener Node-Prozess.
const FROM = 'equiv-probe@whitestag.invalid';
ABSENDER[FROM] = { name, rolle };

const leseDatei = (p) => fs.readFileSync(
  path.join(bausteinVerzeichnis, path.basename(p)), 'utf8');

// html braucht einen (fuer JS) truthy Platzhalter: signiere() haengt die
// Signatur nur an, wenn json.html bereits einen Wert hat -- ein leerer
// String ist falsy und wuerde den kompletten HTML-Zweig ueberspringen
// (`if (!json.html) return json;`). Der Python-Test kennt den Platzhalter
// und schneidet ihn wieder ab.
const INHALT_PLATZHALTER = '__INHALT__';

const ergebnis = signiere(
  { from: FROM, bereich, html: INHALT_PLATZHALTER, text: '', attachments: [] },
  leseDatei,
);

if (ergebnis.__signaturFehler) {
  process.stderr.write('signiere() Fehler: ' + ergebnis.__signaturFehler + '\n');
  process.exit(1);
}

process.stdout.write(JSON.stringify({
  hinweis: hinweisFuer({ name, rolle }),
  html: ergebnis.html,
  attachments: ergebnis.attachments,
}));
