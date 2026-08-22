// Einstiegspunkt des Vault-Spiegels fuer launchd.
//
// Gleicher Grund wie bei den uebrigen Sicherungswerkzeugen: macOS verweigert
// einem launchd-Job aus zsh/bash den Zugriff auf SMB-Freigaben ("Operation
// not permitted", TCC). node hat die Berechtigung und vererbt sie an
// Kindprozesse — hier also auch an rsync.
const { spawnSync } = require('child_process');
const path = require('path');

const skript = path.join(__dirname, 'vault-nas-sync.sh');
const r = spawnSync('/bin/bash', [skript, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
});

if (r.error) {
  console.error('Sync-Skript nicht startbar:', r.error.message);
  process.exit(1);
}
process.exit(r.status === null ? 1 : r.status);
