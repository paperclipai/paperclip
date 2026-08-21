// Einstiegspunkt des Paperclip-DB-Backups fuer launchd.
//
// Warum dieser Umweg: macOS verweigert einem launchd-Job aus zsh/bash den
// Zugriff auf SMB-Freigaben — der Mount ist sichtbar, `ls` und Schreiben
// scheitern aber mit „Operation not permitted" (TCC). Nachgemessen am
// 21.08.2026 mit einer Sonde unter launchd.
//
// /opt/homebrew/bin/node hat die Berechtigung und vererbt sie an
// Kindprozesse. node ist hier also reiner Tueroeffner und enthaelt bewusst
// keine Backup-Logik — die steht lesbar in backup-db.sh. Dasselbe Muster
// nutzt sync-clara-mirror.js fuer /Volumes/homes.
const { spawnSync } = require('child_process');
const path = require('path');

const skript = path.join(__dirname, 'backup-db.sh');
const r = spawnSync('/bin/bash', [skript, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
});

if (r.error) {
  console.error('Backup-Skript nicht startbar:', r.error.message);
  process.exit(1);
}
process.exit(r.status === null ? 1 : r.status);
