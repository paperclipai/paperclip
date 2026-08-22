// Einstiegspunkt der Wiedervorlage fuer launchd.
// Gleicher Grund wie bei run-waechter.js: ohne node scheitert der Zugriff auf
// die SMB-Freigabe still an TCC.
const { spawnSync } = require('child_process');
const path = require('path');
const r = spawnSync('/usr/bin/python3', [path.join(__dirname, 'abnahme.py'),
                                         ...process.argv.slice(2)],
                    { stdio: 'inherit', cwd: __dirname, env: process.env });
if (r.error) { console.error('Abnahme nicht startbar:', r.error.message); process.exit(1); }
process.exit(r.status === null ? 1 : r.status);
