// Einstiegspunkt des Backup-Wächters für launchd.
//
// Gleicher Grund wie bei tools/paperclip-db-backup: macOS verweigert einem
// launchd-Job aus zsh/bash/python den Zugriff auf SMB-Freigaben — der Mount
// ist sichtbar, Lesen scheitert mit „Operation not permitted" (TCC).
// node hat die Berechtigung und vererbt sie an Kindprozesse.
//
// node ist reiner Türöffner und enthält bewusst keine Logik.
const { spawnSync } = require('child_process');
const path = require('path');

const skript = path.join(__dirname, 'waechter.py');
const r = spawnSync('/usr/bin/python3', [skript, ...process.argv.slice(2)], {
  stdio: 'inherit',
  cwd: __dirname,          // damit `import pruefung` greift
  env: process.env,
});

if (r.error) {
  console.error('Wächter nicht startbar:', r.error.message);
  process.exit(1);
}
process.exit(r.status === null ? 1 : r.status);
