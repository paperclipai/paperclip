// Einstiegspunkt der monatlichen Repo-Pruefung fuer launchd.
//
// Gleicher Grund wie bei run-nextcloud-backup.js: macOS verweigert einem
// launchd-Job aus zsh/bash den Zugriff auf CloudStorage und SMB (TCC). Hier
// zaehlt vor allem der Zugang zu `~/.restic/repo.pass` und zur rclone-
// Konfiguration — ohne node bricht die Pruefung mit "Operation not permitted"
// ab und meldet dann faelschlich ein beschaedigtes Repo.
//
// node ist reiner Tueroeffner und enthaelt bewusst keine Logik.
const { spawnSync } = require('child_process');
const path = require('path');

const skript = path.join(__dirname, 'pruefe-repo.sh');
const r = spawnSync('/bin/bash', [skript, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
});

if (r.error) {
  console.error('Pruefskript nicht startbar:', r.error.message);
  process.exit(1);
}
process.exit(r.status === null ? 1 : r.status);
