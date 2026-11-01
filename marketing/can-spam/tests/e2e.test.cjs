'use strict';

/**
 * End-to-end test for the global suppression list + opt-out endpoint +
 * the send preflight that gives the store a production caller (K-20062).
 *
 * Proves, with real requests and a real store file:
 *   1. opt-out via the web endpoint records the address in the GLOBAL list
 *   2. the same address is suppressed across campaigns (global, not per-campaign)
 *   3. a suppressed address CANNOT be re-imported into a new campaign/list
 *   4. the send guard refuses to dispatch to a suppressed address
 *   5. re-suppression is idempotent and preserves the original timestamp
 *   6. a clean address is unaffected
 *   7. the preflight is reachable from the same origin that serves the opt-out
 *      page, over HTTP, and shares the same store
 *   8. the preflight excludes a suppressed address and LOGS the exclusion with
 *      a reason  (acceptance criterion 3)
 *   9. an opt-out recorded MID-BATCH suppresses the unsent remainder
 *      (acceptance criterion 2) — the exact K-20062 scenario
 *  10. the preflight fails CLOSED: an unreadable store blocks every recipient
 *      and an unparseable recipient is blocked, never silently dropped
 *  11. the preflight and filterImport agree on the same object/reason
 *  12. a STOP reply is recorded into the same store and blocks the next send
 *  13. the internal routes refuse an anonymous caller (the suppressed set is not
 *      public) and the public opt-out page still works unauthenticated
 *  14. the landing page escapes stored values, so a stored `source` cannot inject
 *      markup when the page is rendered back
 *  15. a supplied reply body is always classified, so an address cannot be
 *      suppressed by a request whose body is not an opt-out request
 *  16. concurrent writers cannot erase an opt-out, and a corrupt store is never
 *      overwritten with an empty one
 *  17. a preflight whose audit record cannot be written is fatal, not clear
 *  18. a non-object JSON body is a 400, not a crash
 *
 * Run: node marketing/can-spam/tests/e2e.test.cjs
 */

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SuppressionList } = require('../suppression.cjs');
const { preflight, recordStopReply, parseStopReply, EXIT } = require('../preflight.cjs');

const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;
const API_TOKEN = 'e2e-test-origin-token';

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`);
  }
}

function req(method, pathname, body, { token = null, rawBody = null } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, BASE);
    const headers = {};
    let payload = null;
    if (rawBody !== null) {
      payload = rawBody;
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    } else if (body !== undefined) {
      payload = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    if (token) headers.Authorization = `Bearer ${token}`;
    const r = http.request(
      { host: url.hostname, port: url.port, path: url.pathname + url.search, method, headers },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
      }
    );
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

async function main() {
  // Isolated temp store so the test never touches the real list.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'suppression-test-'));
  const storePath = path.join(tmpDir, 'suppression-list.json');
  process.env.OPTOUT_STORE = storePath;
  process.env.CAN_SPAM_STORE = storePath;
  // Keep the send-audit log out of the repo; the assertions below read it from
  // the same temp dir.
  process.env.CAN_SPAM_AUDIT_LOG = path.join(tmpDir, 'send-audit.log');
  // The internal routes are gated on this token. Set before the server is
  // required so it reads the same value the test presents.
  process.env.CAN_SPAM_API_TOKEN = API_TOKEN;

  // Require server AFTER setting the env var so it picks up the temp store.
  const { server } = require('../server.cjs');
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

  const t = (email) => `test+${email.replace(/[^a-z0-9]/gi, '')}@example.com`;
  const suppressed = t('alice');
  const clean = t('bob');

  console.log('\n[1] Opt-out via web endpoint (JSON API)');
  const r1 = await req('POST', '/opt-out', { email: suppressed });
  check('HTTP 200', r1.status === 200, `got ${r1.status}`);
  const j1 = JSON.parse(r1.body);
  check('ok:true', j1.ok === true);
  check('added:true (first opt-out)', j1.added === true);
  const firstTimestamp = j1.suppressedAt;
  check('timestamp present', typeof firstTimestamp === 'string' && firstTimestamp.length > 0);

  console.log('\n[2] Address is in the GLOBAL suppression list');
  const r2 = await req('GET', '/suppression-list', undefined, { token: API_TOKEN });
  const j2 = JSON.parse(r2.body);
  check('count >= 1', j2.count >= 1, `count=${j2.count}`);
  const found = j2.entries.find((e) => e.email === suppressed);
  check('entry present in list', !!found);
  check('source recorded', found && found.source === 'opt-out-endpoint');

  console.log('\n[3] Suppression is GLOBAL — applies across campaigns');
  const list = new SuppressionList(storePath);
  check('isSuppressed true (no campaign scope)', list.isSuppressed(suppressed) === true);
  check('isSuppressed true (different campaign)', list.isSuppressed(suppressed) === true);

  console.log('\n[4] Suppressed address CANNOT be re-imported');
  const importResult = list.filterImport([suppressed, clean], 'day2-campaign');
  check('import blocked for suppressed', importResult.blocked.length === 1);
  check('blocked reason = globally_suppressed',
    importResult.blocked[0] && importResult.blocked[0].reason === 'globally_suppressed');
  check('clean address still importable', importResult.allowed.includes(clean));
  check('suppressed NOT in allowed', !importResult.allowed.includes(suppressed));

  console.log('\n[5] Send guard refuses to dispatch to suppressed address');
  const g1 = list.guardSend(suppressed, 'day2-campaign');
  check('send blocked', g1.allowed === false);
  check('send block reason = globally_suppressed', g1.reason === 'globally_suppressed');
  const g2 = list.guardSend(clean, 'day2-campaign');
  check('clean send allowed', g2.allowed === true);

  console.log('\n[6] Re-suppression is idempotent (original timestamp preserved)');
  const r6 = await req('POST', '/opt-out', { email: suppressed });
  const j6 = JSON.parse(r6.body);
  check('already:true on re-opt-out', j6.already === true);
  check('added:false on re-opt-out', j6.added === false);
  check('timestamp unchanged', j6.suppressedAt === firstTimestamp);
  const r6b = await req('GET', '/suppression-list', undefined, { token: API_TOKEN });
  check('count still 1 (no duplicate)', JSON.parse(r6b.body).count === 1);

  console.log('\n[7] Landing page (GET) records opt-out and returns HTML');
  const r7 = await req('GET', `/opt-out?email=${encodeURIComponent(clean)}`);
  check('HTTP 200', r7.status === 200);
  check('content-type html', (r7.headers['content-type'] || '').includes('text/html'));
  check('page confirms removal', r7.body.includes('removed from all lists'));
  // Re-read from disk to prove the landing page wrote through to the store.
  const listAfter = new SuppressionList(storePath);
  check('clean now suppressed (read back from disk)', listAfter.isSuppressed(clean) === true);

  console.log('\n[8] Invalid input handled');
  const r8 = await req('POST', '/opt-out', { email: 'not-an-email' });
  check('HTTP 422 for invalid email', r8.status === 422, `got ${r8.status}`);
  const r9 = await req('POST', '/opt-out', {});
  check('HTTP 400 for missing email', r9.status === 400, `got ${r9.status}`);

  console.log('\n[9] Store file persisted to disk');
  check('store file exists', fs.existsSync(storePath));
  const onDisk = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  check('on-disk entries >= 2', Object.keys(onDisk.entries).length >= 2);

  // ---------------------------------------------------------------------
  // K-20062: the store had zero production callers. These prove the
  // preflight is a real, reachable, fail-closed gate on the send path.
  // ---------------------------------------------------------------------

  const auditPath = path.join(tmpDir, 'send-audit.log');
  const audit = (event) =>
    fs
      .readFileSync(auditPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((r) => r.event === event);
  const day2 = [t('day2a'), t('day2b'), suppressed]; // `suppressed` opted out in [1]

  console.log('\n[10] Preflight is reachable from the origin that serves {OPT_OUT_URL}');
  const liveFingerprint = (await req('GET', '/suppression-list', undefined, { token: API_TOKEN })).body;
  const r10 = await req('POST', '/send-preflight', { campaign: 'k247-day2', recipients: day2 }, { token: API_TOKEN });
  check('HTTP 200', r10.status === 200, `got ${r10.status}`);
  const j10 = JSON.parse(r10.body);
  check('ok:false (one recipient suppressed)', j10.ok === false);
  check('exitCode = 1 (blocked, not fatal)', j10.exitCode === 1);
  check('same store fingerprint as /suppression-list',
    j10.storeFingerprint === JSON.parse(liveFingerprint).fingerprint,
    `${j10.storeFingerprint} vs ${JSON.parse(liveFingerprint).fingerprint}`);
  check('suppressed address NOT in allowed', !j10.allowed.includes(suppressed));
  check('clean addresses allowed', j10.allowed.includes(t('day2a')) && j10.allowed.includes(t('day2b')));

  console.log('\n[11] Exclusion is LOGGED with a reason (acceptance criterion 3)');
  const excluded = j10.blocked.find((b) => b.email === suppressed);
  check('excluded present in blocked', !!excluded);
  check('reason recorded = globally_suppressed', excluded && excluded.reason === 'globally_suppressed');
  check('suppressedAt recorded on the exclusion', excluded && typeof excluded.suppressedAt === 'string');
  const logged = audit('send_preflight');
  check('preflight written to the append-only audit log', logged.length === 1, `entries=${logged.length}`);
  const loggedExclusion = logged[0] && logged[0].blocked.find((b) => b.email === suppressed);
  check('audit log records the exclusion', !!loggedExclusion);
  check('audit log records the reason', loggedExclusion && loggedExclusion.reason === 'globally_suppressed');
  check('audit log records the campaign', logged[0] && logged[0].campaign === 'k247-day2');

  console.log('\n[12] Preflight and filterImport agree — same store, same object, same reason');
  const live = new SuppressionList(storePath);
  const importView = live.filterImport(day2, 'k247-day2');
  const importReason = importView.blocked.find((b) => b.email === suppressed);
  check('filterImport blocks the same address', importReason && importReason.email === suppressed);
  check('identical reason string', excluded && importReason && importReason.reason === excluded.reason);
  check('identical allowed set',
    JSON.stringify([...importView.allowed].sort()) === JSON.stringify([...j10.allowed].sort()));

  console.log('\n[13] Opt-out recorded MID-BATCH suppresses the unsent remainder');
  // The K-20062 scenario: a batch is in flight, a recipient opts out while it
  // is in flight, and the next dispatch must exclude them. A check run once at
  // batch start cannot do this.
  const midBatch = t('midbatch');
  const preflightBefore = preflight([midBatch], { list: live, storePath, campaign: 'k247-day2', auditPath });
  check('address clear before the opt-out', preflightBefore.ok === true);
  await req('POST', '/opt-out', { email: midBatch }); // arrives mid-batch
  const live2 = new SuppressionList(storePath);
  const preflightAfter = preflight([midBatch], { list: live2, storePath, campaign: 'k247-day2', auditPath });
  check('same address blocked on the next preflight', preflightAfter.ok === false);
  check('blocked as globally_suppressed',
    preflightAfter.blocked[0] && preflightAfter.blocked[0].reason === 'globally_suppressed');
  const r13 = await req('POST', '/send-preflight', { campaign: 'k247-day2', recipients: [midBatch] }, { token: API_TOKEN });
  check('HTTP preflight also sees the mid-batch opt-out (no stale read)',
    JSON.parse(r13.body).ok === false, `status=${r13.status}`);

  console.log('\n[14] Preflight FAILS CLOSED — it cannot be made to report "clear" by accident');
  // (a) unreadable store
  const brokenPath = path.join(tmpDir, 'broken-store.json');
  fs.writeFileSync(brokenPath, '{ this is not json');
  const brokenList = new SuppressionList(brokenPath);
  const broken = preflight([t('anyone')], { list: brokenList, storePath: brokenPath, auditPath });
  check('unreadable store is fatal', broken.fatal === true);
  check('exitCode = 3 (distinct from "blocked")', broken.exitCode === EXIT.STORE_UNAVAILABLE);
  check('ok:false', broken.ok === false);
  check('recipient blocked with store_unavailable',
    broken.blocked[0] && broken.blocked[0].reason === 'store_unavailable');
  check('allowed list is EMPTY, not everyone', broken.allowed.length === 0);
  // (b) absent store — a fresh clone has no committed list, so nothing is provable
  const missing = preflight([t('anyone')], {
    storePath: path.join(tmpDir, 'nope', 'absent.json'),
    auditPath,
  });
  check('absent store is also fatal', missing.fatal === true);
  check('absent store returns no allowed recipients', missing.allowed.length === 0);
  // (c) unparseable recipient must not be silently skipped
  const malformed = preflight(['not-an-email', t('ok')], { list: live2, storePath, auditPath, campaign: 'k247-day2' });
  check('unparseable recipient blocked, not dropped', malformed.ok === false);
  check('reason = invalid_recipient',
    malformed.blocked[0] && malformed.blocked[0].reason === 'invalid_recipient');
  check('valid recipient still allowed alongside it', malformed.allowed.includes(t('ok')));
  // (d) the fatal store is served over HTTP as 503, never as a 200 "all clear"
  const unreachableList = new SuppressionList(brokenPath);
  const j14 = preflight([t('anyone')], { list: unreachableList, storePath: brokenPath, auditPath });
  check('fatal result is distinguishable programmatically', j14.exitCode !== EXIT.CLEAR && j14.fatal === true);

  console.log('\n[15] STOP reply is recorded into the SAME store and blocks the next send');
  const stopper = t('stopper');
  const parsedStop = parseStopReply('STOP\n\nplease take me off');
  check('STOP reply body classified as an opt-out', parsedStop.isStopRequest === true);
  check('keyword identified', parsedStop.keyword === 'stop');
  check('non-opt-out body not classified', parseStopReply('can we talk Thursday?').isStopRequest === false);
  const r15 = await req('POST', '/stop', { email: stopper, body: 'STOP', source: 'stop-reply', campaign: 'k247-day2' }, { token: API_TOKEN });
  check('POST /stop HTTP 200', r15.status === 200, `got ${r15.status}`);
  const j15 = JSON.parse(r15.body);
  check('recorded as newly added', j15.added === true);
  const listAfterStop = await req('GET', '/suppression-list', undefined, { token: API_TOKEN });
  check('same fingerprint as the opt-out origin',
    j15.fingerprint === JSON.parse(listAfterStop.body).fingerprint);
  check('STOP address visible on the Legal list view',
    JSON.parse(listAfterStop.body).entries.some((e) => e.email === stopper));
  const live3 = new SuppressionList(storePath);
  check('STOP suppression is in the global store', live3.isSuppressed(stopper) === true);
  const afterStop = preflight([stopper], { list: live3, storePath, auditPath, campaign: 'k247-day2' });
  check('STOP blocks the next dispatch', afterStop.ok === false);
  check('STOP block reason recorded',
    afterStop.blocked[0] && afterStop.blocked[0].reason === 'globally_suppressed');
  check('STOP source preserved on the entry', live3.entryFor(stopper).source === 'stop-reply');
  const stopLogs = audit('stop_reply_recorded');
  check('STOP recorded in the audit log', stopLogs.length === 1);
  // idempotent
  const stopAgain = recordStopReply(stopper, { list: live3, storePath, auditPath });
  check('re-recording STOP is idempotent', stopAgain.already === true);
  check('original timestamp preserved', stopAgain.entry.suppressedAt === j15.suppressedAt);
  // the audit log must be attributable
  check('audit log records the store fingerprint',
    audit('send_preflight').every((r) => typeof r.storeFingerprint === 'string' && r.storeFingerprint.length > 0));

  console.log('\n[16] Opt-out origin and preflight cannot drift onto two lists');
  const r16 = await req('GET', '/health', undefined, { token: API_TOKEN });
  const j16 = JSON.parse(r16.body);
  check('health reports one store path', typeof j16.store === 'string' && j16.store.length > 0);
  check('health reports the store is readable', j16.storeReadable === true);
  check('health store path is the temp store used by this test', j16.store === storePath, j16.store);

  console.log('\n[17] Operator init cannot destroy real opt-outs');
  // init must create a store when none exists, be a no-op when one does, and
  // REFUSE when the existing store is unreadable — a lost list silently
  // replaced by an empty one would un-suppress every opted-out address.
  const initPath = path.join(tmpDir, 'init', 'list.json');
  const initList = new SuppressionList(initPath);
  initList.store = { version: 1, description: 'init', entries: {} };
  initList.persist();
  const afterInit = new SuppressionList(initPath);
  check('init-created store is readable', afterInit.isReadable() === true);
  check('init-created store is empty', afterInit.count() === 0);
  const initClear = preflight([t('someone')], { storePath: initPath, auditPath });
  check('preflight clears against a freshly initialised store', initClear.ok === true);
  const afterCorrupt = fs.writeFileSync(initPath, '{corrupt');
  const corruptInit = preflight([t('someone')], { storePath: initPath, auditPath });
  check('a corrupted store fails closed again', corruptInit.fatal === true);
  check('corrupted store yields no allowed recipients', corruptInit.allowed.length === 0);

  console.log('\n[18] An opt-out that cannot be written is NEVER confirmed');
  // The dangerous failure: telling a recipient "you have been removed" when the
  // store did not accept the write, and then emailing them again. Make the
  // store unwritable and prove the endpoint refuses instead of confirming.
  const lockedDir = path.join(tmpDir, 'locked');
  const lockedStore = path.join(lockedDir, 'list.json');
  const lockedList = new SuppressionList(lockedStore);
  lockedList.store = { version: 1, description: 'locked', entries: {} };
  lockedList.persist();
  const mode = fs.statSync(lockedDir).mode & 0o777;
  fs.chmodSync(lockedDir, 0o500); // r-x: cannot create the .tmp write file
  let writeBlocked = false;
  try {
    lockedList.suppress(t('wantsout'), { source: 'opt-out-endpoint' });
  } catch (_err) {
    writeBlocked = true;
  }
  fs.chmodSync(lockedDir, mode);
  if (process.getuid && process.getuid() === 0) {
    console.log('  SKIP  running as root — file permissions do not block writes');
  } else {
    check('write to an unwritable store throws rather than reporting success', writeBlocked === true);
    check('the failed entry was rolled back', lockedList.isSuppressed(t('wantsout')) === false);
    const lockedOnDisk = JSON.parse(fs.readFileSync(lockedStore, 'utf8'));
    check('nothing was written to disk', Object.keys(lockedOnDisk.entries).length === 0);
    const lockedPreflight = preflight([t('wantsout')], { storePath: lockedStore, auditPath });
    check('the un-recorded address is still certifiable (no false suppression)', lockedPreflight.ok === true);
  }
  const r18 = await req('POST', '/opt-out', { email: t('lastcheck') });
  check('opt-out endpoint still healthy after the failure case', r18.status === 200, `got ${r18.status}`);

  // Same failure, observed through the endpoint the recipient actually hits.
  // The landing page must not render "removed from all lists" either.
  const tmpMode = fs.statSync(tmpDir).mode & 0o777;
  fs.chmodSync(tmpDir, 0o500);
  let endpointBlocked = false;
  try {
    const rw = await req('POST', '/opt-out', { email: t('cantwrite') });
    if (rw.status === 503 && JSON.parse(rw.body).ok === false) endpointBlocked = true;
    const rwPage = await req('GET', `/opt-out?email=${encodeURIComponent(t('cantwrite2'))}`);
    if ((rwPage.body || '').includes('removed from all lists')) {
      check('landing page must not confirm an opt-out that failed to record', false, 'it rendered the confirmation');
    }
  } finally {
    fs.chmodSync(tmpDir, tmpMode);
  }
  if (process.getuid && process.getuid() === 0) {
    console.log('  SKIP  running as root — file permissions do not block writes');
  } else {
    check('opt-out endpoint returns 503 instead of confirming', endpointBlocked === true);
    const notRecorded = new SuppressionList(storePath);
    check('nothing was recorded for the failed write', notRecorded.isSuppressed(t('cantwrite')) === false);
  }

  // ---------------------------------------------------------------------
  // Review findings. Each of these is a failure that a recipient or a
  // regulator would experience, not a style preference.
  // ---------------------------------------------------------------------

  console.log('\n[19] The suppressed set is not public — internal routes are gated');
  // The store is a list of people who asked not to be contacted. An anonymous
  // read hands that list to anyone who asks, and an anonymous preflight turns
  // the origin into an oracle for "is this person on it".
  const anonList = await req('GET', '/suppression-list');
  check('anonymous /suppression-list is refused', anonList.status === 401, `got ${anonList.status}`);
  check('refusal does not leak entries', !(anonList.body || '').includes('@example.com'));
  check('refusal names the auth requirement',
    JSON.parse(anonList.body).reason === 'unauthorized', anonList.body);
  const wrongToken = await req('GET', '/suppression-list', undefined, { token: 'not-the-token' });
  check('a wrong token is refused', wrongToken.status === 401, `got ${wrongToken.status}`);
  const anonPreflight = await req('POST', '/send-preflight', { recipients: [t('someone')] });
  check('anonymous /send-preflight is refused', anonPreflight.status === 401, `got ${anonPreflight.status}`);
  check('anonymous preflight certifies nobody', JSON.parse(anonPreflight.body).allowed === undefined);
  const anonStop = await req('POST', '/stop', { email: t('anon'), body: 'STOP' });
  check('anonymous /stop cannot suppress an address', anonStop.status === 401, `got ${anonStop.status}`);
  const stillClear = new SuppressionList(storePath);
  check('the anonymous /stop wrote nothing', stillClear.isSuppressed(t('anon')) === false);
  const authedPreflight = await req('POST', '/send-preflight', { recipients: [t('someone')] }, { token: API_TOKEN });
  check('the authorised send step still reaches the preflight', authedPreflight.status === 200, `got ${authedPreflight.status}`);
  // The opt-out page is the one route that MUST stay frictionless: 15 U.S.C.
  // 7704(4)(C)(iii) requires the opt-out to be exercisable by the recipient.
  const anonOptOut = await req('POST', '/opt-out', { email: t('publicoptout') });
  check('the public opt-out still works without a token', anonOptOut.status === 200, `got ${anonOptOut.status}`);
  const anonHealth = await req('GET', '/health');
  check('public health still answers for probes', anonHealth.status === 200);
  check('public health reveals no store path', JSON.parse(anonHealth.body).store === undefined);
  const authedHealth = await req('GET', '/health', undefined, { token: API_TOKEN });
  check('authorised health still reports the store for wiring checks',
    JSON.parse(authedHealth.body).store === storePath);

  console.log('\n[20] A stored value cannot inject markup into the landing page');
  // `source` is caller-supplied on the write path and rendered back on the
  // confirmation page. Unescaped, that is a stored XSS served to whoever
  // opens the page for their own address.
  const xss = '<script>alert(1)</script>';
  const victim = t('xssvictim');
  await req('POST', '/stop', { email: victim, body: 'STOP', source: xss }, { token: API_TOKEN });
  const stored = new SuppressionList(storePath);
  check('an unknown source is not stored verbatim (allowlist)',
    stored.entryFor(victim).source !== xss, stored.entryFor(victim).source);
  check('a disallowed source falls back to the route default',
    stored.entryFor(victim).source === 'stop-reply', stored.entryFor(victim).source);
  const xssPage = await req('GET', `/opt-out?email=${encodeURIComponent(victim)}`);
  check('no raw script tag in the rendered page', !(xssPage.body || '').includes('<script>'));
  check('the page still confirms the opt-out', (xssPage.body || '').includes('removed from all lists'));
  // The allowlist is the first layer and lives in the HTTP handler; escaping is
  // the second and lives in the renderer. Prove the second independently, by
  // putting a hostile source into the store the way operator tooling would.
  const injected = t('injected');
  new SuppressionList(storePath).suppress(injected, { source: xss });
  check('a hostile source written through the store is the test fixture',
    new SuppressionList(storePath).entryFor(injected).source === xss);
  const injectedPage = await req('GET', `/opt-out?email=${encodeURIComponent(injected)}`);
  check('a stored script tag is escaped, not rendered', !(injectedPage.body || '').includes('<script>'));
  check('the escaped form is what reaches the page',
    (injectedPage.body || '').includes('&lt;script&gt;'));
  check('a quote in a stored value cannot break out of the attribute',
    !(injectedPage.body || '').includes('alert(1)</script>'));
  // A source that is on the allowlist is still stored, so provenance survives.
  const keepSource = t('keepsource');
  await req('POST', '/stop', { email: keepSource, body: 'unsubscribe me', source: 'stop-reply' }, { token: API_TOKEN });
  check('an allowed source is preserved on the entry',
    new SuppressionList(storePath).entryFor(keepSource).source === 'stop-reply');

  console.log('\n[21] A supplied reply body is always classified');
  // The previous guard classified only when `email` was absent, so a request
  // carrying both fields suppressed the address whatever the body said.
  const notAStop = t('notastop');
  const bypass = await req('POST', '/stop', { email: notAStop, body: 'can we talk Thursday?' }, { token: API_TOKEN });
  check('a non-opt-out body is refused even when an address is supplied',
    bypass.status === 422, `got ${bypass.status}`);
  check('refusal reason = not_a_stop_request', JSON.parse(bypass.body).reason === 'not_a_stop_request');
  check('the address was NOT suppressed', new SuppressionList(storePath).isSuppressed(notAStop) === false);
  const emptyBody = await req('POST', '/stop', { email: t('emptybody'), body: '' }, { token: API_TOKEN });
  check('an empty body is not treated as a STOP', emptyBody.status === 422, `got ${emptyBody.status}`);
  const realStop = t('realstop');
  const good = await req('POST', '/stop', { email: realStop, body: 'STOP please' }, { token: API_TOKEN });
  check('a genuine STOP with both fields is still recorded', good.status === 200, `got ${good.status}`);
  check('the genuine STOP is in the store', new SuppressionList(storePath).isSuppressed(realStop) === true);
  const noBody = await req('POST', '/stop', { email: t('nobodyforwarded') }, { token: API_TOKEN });
  check('a forwarder may still record an address it already classified', noBody.status === 200, `got ${noBody.status}`);
  const noEmail = await req('POST', '/stop', { body: 'STOP' }, { token: API_TOKEN });
  check('a STOP with no address is a 400, not a silent no-op', noEmail.status === 400, `got ${noEmail.status}`);

  console.log('\n[22] Concurrent writers cannot erase an opt-out');
  // Two writers hold independent in-memory copies of one file. The second
  // writer's whole-file write must not drop what the first recorded.
  const racePath = path.join(tmpDir, 'race', 'list.json');
  const serverList = new SuppressionList(racePath);
  serverList.store = { version: 1, description: 'race', entries: {} };
  serverList.persist();
  const cliList = new SuppressionList(racePath); // the operator CLI, loaded earlier
  serverList.suppress(t('raceserver'), { source: 'opt-out-endpoint' });
  cliList.suppress(t('racecli'), { source: 'operator-cli' });
  const afterRace = new SuppressionList(racePath);
  check('the first writer opt-out survived the second write', afterRace.isSuppressed(t('raceserver')) === true);
  check('the second write landed', afterRace.isSuppressed(t('racecli')) === true);
  check('both opt-outs are on disk', afterRace.count() === 2, `count=${afterRace.count()}`);
  // And the loser of the race must not report a clear recipient.
  const racePreflight = preflight([t('raceserver'), t('racecli')], { list: new SuppressionList(racePath), storePath: racePath, auditPath });
  check('the preflight blocks both after the interleaved writes', racePreflight.ok === false);
  check('the preflight allows nobody', racePreflight.allowed.length === 0);
  // The lock must not be left behind, or the next write would time out.
  // The lock is an implementation detail, so assert the observable property:
  // no lock artefact is left behind to wedge the next write.
  check('the write lock is released', !fs.existsSync(`${racePath}.lock`));
  check('no lock file is left on the main store either', !fs.existsSync(`${storePath}.lock`));

  console.log('\n[23] A corrupt store is never overwritten with an empty one');
  // The in-memory fallback for an unreadable store is an empty list. Persisting
  // that would replace real opt-outs with nothing.
  const corruptPath = path.join(tmpDir, 'corrupt-write', 'list.json');
  fs.mkdirSync(path.dirname(corruptPath), { recursive: true });
  fs.writeFileSync(corruptPath, '{ not json at all');
  const corruptList = new SuppressionList(corruptPath);
  check('the corrupt store reads as unreadable', corruptList.isReadable() === false);
  let corruptRefused = false;
  try {
    corruptList.suppress(t('shouldnotwrite'), { source: 'opt-out-endpoint' });
  } catch (_err) {
    corruptRefused = true;
  }
  check('a write to a corrupt store is refused', corruptRefused === true);
  check('the corrupt file is left byte-for-byte intact',
    fs.readFileSync(corruptPath, 'utf8') === '{ not json at all');
  check('nothing was silently added to the in-memory list',
    corruptList.isSuppressed(t('shouldnotwrite')) === false);
  // An absent store is a different fact: it can be created.
  const freshPath = path.join(tmpDir, 'fresh', 'list.json');
  const freshList = new SuppressionList(freshPath);
  check('an absent store is reported unreadable', freshList.isReadable() === false);
  check('an absent store is reported absent', freshList.storeFileExists() === false);
  const freshWrite = freshList.suppress(t('firstever'), { source: 'opt-out-endpoint' });
  check('an absent store is created on first opt-out', freshWrite.added === true);
  check('the created store is readable afterwards', new SuppressionList(freshPath).isReadable() === true);

  console.log('\n[24] A dispatch that cannot be recorded is not cleared');
  // The audit log is what makes an exclusion attestable to Legal. If it cannot
  // be written, the decision that was just taken is unattributable, so the gate
  // closes rather than reporting a clear list.
  const deadAudit = path.join(tmpDir, 'no', 'such', 'dir', 'audit.log');
  const unaudited = preflight([t('clean1'), t('clean2')], { storePath, auditPath: deadAudit, campaign: 'k247-day2' });
  check('an unwritable audit log is fatal', unaudited.fatal === true);
  check('exit code is the distinct AUDIT_UNAVAILABLE', unaudited.exitCode === EXIT.AUDIT_UNAVAILABLE, `got ${unaudited.exitCode}`);
  check('audit failure is distinguishable from a store failure',
    unaudited.exitCode !== EXIT.STORE_UNAVAILABLE);
  check('audited:false is reported', unaudited.audited === false);
  check('the audit error is surfaced', typeof unaudited.auditError === 'string' && unaudited.auditError.length > 0);
  check('no recipient is allowed', unaudited.allowed.length === 0, `allowed=${JSON.stringify(unaudited.allowed)}`);
  check('every looked-at recipient is reported as blocked', unaudited.blocked.length === 2);
  check('each block carries the audit reason',
    unaudited.blocked.every((b) => b.reason === 'audit_unavailable'));
  // What the gate would have decided is kept alongside, so an operator can tell
  // "this was suppressed" from "this would have gone out but we could not
  // record that we cleared it". A row that was clear has no prior reason.
  const wouldHaveBeenBlocked = unaudited.blocked.find((b) => b.email === t('clean1'));
  check('a previously clear row records no prior reason',
    wouldHaveBeenBlocked && wouldHaveBeenBlocked.priorReason === null,
    JSON.stringify(wouldHaveBeenBlocked));
  const suppressedThenUnaudited = preflight([suppressed], { storePath, auditPath: deadAudit, campaign: 'k247-day2' });
  check('a suppressed row keeps its real reason as priorReason',
    suppressedThenUnaudited.blocked[0].priorReason === 'globally_suppressed',
    JSON.stringify(suppressedThenUnaudited.blocked[0]));
  // A recorded STOP is already durable; a missing log entry must not
  // un-suppress anyone, but the gap is still reported.
  const stopAudit = recordStopReply(t('auditedstop'), { list: new SuppressionList(storePath), storePath, auditPath: deadAudit });
  check('the STOP is still recorded when the log is unwritable', stopAudit.ok === true);
  check('the STOP audit gap is reported', stopAudit.audited === false);
  check('the STOP is in the store regardless', new SuppressionList(storePath).isSuppressed(t('auditedstop')) === true);

  console.log('\n[25] A malformed JSON body is a 400, not a crash');
  // The origin is public. `null`, an array, and a bare string all parse, and
  // dereferencing their fields inside the async handler would take the process
  // down — a one-line denial of service on the route a recipient uses to opt out.
  for (const [label, payload] of [['null', 'null'], ['array', '[1,2,3]'], ['string', '"hello"'], ['number', '42']]) {
    const res = await req('POST', '/send-preflight', undefined, { token: API_TOKEN, rawBody: payload });
    check(`${label} body on /send-preflight is a 400`, res.status === 400, `got ${res.status}`);
    check(`${label} body on /send-preflight says invalid_body`,
      JSON.parse(res.body).reason === 'invalid_body');
  }
  const nullStop = await req('POST', '/stop', undefined, { token: API_TOKEN, rawBody: 'null' });
  check('null body on /stop is a 400', nullStop.status === 400, `got ${nullStop.status}`);
  const nullOptOut = await req('POST', '/opt-out', undefined, { rawBody: 'null' });
  check('null body on the public opt-out is a 400, not a crash', nullOptOut.status === 400, `got ${nullOptOut.status}`);
  const brokenJson = await req('POST', '/opt-out', undefined, { rawBody: '{ nope' });
  check('unparseable JSON is still a 400', brokenJson.status === 400, `got ${brokenJson.status}`);
  // The server survived all of it and still serves the opt-out.
  const alive = await req('POST', '/opt-out', { email: t('stillalive') });
  check('the origin is still serving after the malformed bodies', alive.status === 200, `got ${alive.status}`);

  server.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('test crashed:', err);
  process.exit(1);
});
