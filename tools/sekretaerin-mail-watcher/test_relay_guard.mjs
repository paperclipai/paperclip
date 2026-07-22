// test_relay_guard.mjs  —  node test_relay_guard.mjs
// Repliziert nur die Guard-Entscheidung des Relay-Node "Validate Request",
// damit die Vier-Augen-Logik testbar ist, bevor sie in n8n landet.
import assert from 'node:assert';

const APPROVAL_SECRET = 'TEST-SECRET';

// Entscheidung: darf die office@-Mail raus? 'ok' | 'reject'
function guard({ from, addrs, approval }) {
  if (from === 'office@whitestag.ai') {
    const onlyWalter = addrs.length > 0 && addrs.every(a => a === 'ws@whitestag.ai');
    const approved = approval && approval === APPROVAL_SECRET;
    if (!onlyWalter && !approved) return 'reject';
  }
  return 'ok';
}

// Draft an Walter (Phase-2-Weg) — immer erlaubt
assert.equal(guard({ from: 'office@whitestag.ai', addrs: ['ws@whitestag.ai'], approval: '' }), 'ok');
// office@ an Externe OHNE Freigabe — blockiert
assert.equal(guard({ from: 'office@whitestag.ai', addrs: ['k@example.de'], approval: '' }), 'reject');
// office@ an Externe mit FALSCHEM Secret — blockiert
assert.equal(guard({ from: 'office@whitestag.ai', addrs: ['k@example.de'], approval: 'WRONG' }), 'reject');
// office@ an Externe mit GÜLTIGER Freigabe — erlaubt
assert.equal(guard({ from: 'office@whitestag.ai', addrs: ['k@example.de'], approval: 'TEST-SECRET' }), 'ok');
// gemischt: extern + ws@ zusammen, ohne Freigabe — blockiert (nicht "nur ws@")
assert.equal(guard({ from: 'office@whitestag.ai', addrs: ['ws@whitestag.ai', 'k@example.de'], approval: '' }), 'reject');

console.log('relay guard: alle 5 Fälle ok');
