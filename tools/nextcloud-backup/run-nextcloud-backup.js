// Einstiegspunkt der Auswaerts-Sicherung fuer launchd.
//
// Gleicher Grund wie bei tools/paperclip-db-backup und tools/backup-waechter:
// macOS verweigert einem launchd-Job aus zsh/bash den Zugriff auf CloudStorage
// (SynologyDrive) und SMB — "Operation not permitted" (TCC). node hat die
// Berechtigung und vererbt sie an Kindprozesse. Am 21.08.2026 fuer beide
// Speicherorte unter launchd nachgemessen.
//
// node ist reiner Tueroeffner und enthaelt bewusst keine Logik.
const { spawnSync } = require('child_process');
const path = require('path');

const skript = path.join(__dirname, 'nextcloud-backup.sh');
const r = spawnSync('/bin/bash', [skript, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
});

if (r.error) {
  console.error('Backup-Skript nicht startbar:', r.error.message);
  process.exit(1);
}
process.exit(r.status === null ? 1 : r.status);
