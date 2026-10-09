/** One-session loopback browser qualification harness. No Paperclip authority. */
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { build } from 'esbuild';
import { createProof, createProofServer, DELAY_MS } from './proof.mjs';
const key = process.env.SPEKO_MCP_API_KEY;
if (!key) throw new Error('Credential required in environment');
const state = JSON.parse(await readFile(`${homedir()}/.paperclip/speko-proof/state.json`, 'utf8'));
const out = resolve(process.env.SPEKO_PROOF_OUTPUT ?? `${homedir()}/.paperclip/speko-proof/browser-${Date.now()}`);
await mkdir(dirname(out), { recursive: true, mode: 0o700 }); await mkdir(out, { mode: 0o700 });
const sourceDigests = {};
for (const file of ['browser-server.mjs', 'browser-client.mjs', 'browser.html', 'proof.mjs', 'application-notification.txt']) sourceDigests[file] = createHash('sha256').update(await readFile(new URL(file, import.meta.url))).digest('hex');
await writeFile(resolve(out, 'source.json'), JSON.stringify({ startedAt: new Date().toISOString(), sourceDigests }), { mode: 0o600 });
const bundle = await build({ entryPoints: [new URL('./browser-client.mjs', import.meta.url).pathname], bundle: true, write: false, platform: 'browser', format: 'esm' });
const inputs = new Map();
for (const name of ['start', 'followup']) {
  const data = await readFile(new URL(`../../.paperclip-local/speko-proof-audio/${name}.pcm`, import.meta.url));
  if (!data.length || data.length % 2 || data.length > 48000 * 2 * 10) throw new Error('Invalid synthetic fixture');
  inputs.set(name, data);
}
const port = Number(process.env.SPEKO_BROWSER_PORT ?? 3199);
const origin = `http://127.0.0.1:${port}`;
const launch = randomBytes(24).toString('hex'), csrf = randomBytes(24).toString('hex'), cookie = randomBytes(24).toString('hex');
const proof = createProof({ signingSecret: state.signingSecret, onEvent: (event) => { if (event.kind === 'request_accepted') startTime = Date.now(); } });
const hook = createProofServer(proof);
let sessionId, attempted = false, startTime, ending, stopped = false;
async function provider(path, body) {
  const r = await fetch(`https://api.speko.dev${path}`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`Provider returned ${r.status}`);
  return r.json();
}
async function endSession() {
  if (!sessionId) return;
  ending ??= provider(`/v1/calls/${sessionId}/end`, {});
  try { await ending; } catch (error) { ending = undefined; throw error; }
}
const server = createServer(async (req, res) => {
  const reply = (code, data, type = 'application/json') => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(type === 'application/json' ? JSON.stringify(data) : data); };
  try {
    if (req.headers.host !== `127.0.0.1:${port}`) return reply(403, { error: 'Wrong host' });
    if (req.method === 'GET' && req.url === `/launch/${launch}`) {
      res.setHeader('set-cookie', `proof=${cookie}; HttpOnly; SameSite=Strict; Path=/`);
      res.writeHead(302, { location: '/', 'referrer-policy': 'no-referrer' }); return res.end();
    }
    if (!req.headers.cookie?.split(';').some((part) => part.trim() === `proof=${cookie}`)) return reply(401, { error: 'Launch this isolated proof from its private link' });
    if (req.method === 'GET' && req.url === '/') return reply(200, (await readFile(new URL('./browser.html', import.meta.url), 'utf8')).replace('CONFIG_JSON', JSON.stringify({ csrf })), 'text/html');
    if (req.method === 'GET' && req.url === '/client.js') return reply(200, bundle.outputFiles[0].contents, 'text/javascript');
    if (req.method === 'GET' && ['/input/start', '/input/followup'].includes(req.url)) return reply(200, inputs.get(req.url.split('/').at(-1)), 'application/octet-stream');
    if (req.method !== 'POST' || req.headers.origin !== origin || req.headers['x-proof-csrf'] !== csrf) return reply(403, { error: 'Same-origin request required' });
    const limit = req.url === '/audio' ? 20 * 1024 * 1024 : 256 * 1024;
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > limit) return reply(413, { error: 'Request too large' }); chunks.push(chunk); }
    const raw = Buffer.concat(chunks);
    if (req.url === '/audio') { await writeFile(resolve(out, 'received.webm'), raw, { mode: 0o600 }); return reply(200, { saved: true }); }
    const body = JSON.parse(raw.toString('utf8'));
    if (req.url === '/session') {
      if (attempted) return reply(409, { error: 'One session per probe. Creation is never blindly retried.' });
      attempted = true;
      await writeFile(resolve(out, 'intent.json'), JSON.stringify({ action: 'create_browser_session', at: new Date().toISOString() }), { mode: 0o600 });
      const session = await provider('/v1/sessions', { mode: 'cascade', agentId: state.agentId, ttlSeconds: 120, maxDurationSeconds: 180, constraints: { allowedProviders: { llm: ['openai:gpt-4.1'] } }, systemPrompt: await readFile(new URL('./application-notification.txt', import.meta.url), 'utf8') });
      sessionId = session.sessionId;
      await writeFile(resolve(out, 'session.json'), JSON.stringify({ sessionId }), { mode: 0o600 });
      return reply(200, { sessionId, transportToken: session.transportToken, transportUrl: session.transportUrl });
    }
    if (req.url === '/evidence') {
      const evidence = proof.evidence();
      // A server-owned clock, bound to the first signed submission, schedules
      // the synthetic completion hint; the page cannot advance it.
      return reply(200, { acceptedRequests: evidence.acceptedRequests, resultReturned: evidence.resultReturned, notificationReady: startTime !== undefined && Date.now() >= startTime + DELAY_MS + 1000,
        expectedNumber: evidence.expectedSyntheticResult?.match(/Verification number (\d+)/)?.[1] ?? null });
    }
    if (req.url === '/report') { await writeFile(resolve(out, 'browser-report.json'), JSON.stringify(body, null, 2), { mode: 0o600 }); await writeFile(resolve(out, 'proof.json'), JSON.stringify(proof.evidence(), null, 2), { mode: 0o600 }); return reply(200, { saved: true }); }
    if (req.url === '/end') { await endSession(); return reply(200, { ended: true }); }
    return reply(404, { error: 'Not found' });
  } catch { return reply(502, { error: 'Probe request failed; inspect private evidence. Do not retry session creation.' }); }
});
try {
  hook.listen(3198, '127.0.0.1'); await once(hook, 'listening');
  server.listen(port, '127.0.0.1'); await once(server, 'listening');
} catch (error) { hook.close(); server.close(); throw error; }
console.log(JSON.stringify({ url: `${origin}/launch/${launch}`, output: out }));
async function stop() {
  if (stopped) return; stopped = true;
  try { await endSession(); } finally { proof.close(); hook.close(); hook.closeAllConnections(); server.close(); server.closeAllConnections(); clearTimeout(cap); }
}
const cap = setTimeout(() => { void stop(); }, 270000);
process.once('SIGINT', () => { void stop(); }); process.once('SIGTERM', () => { void stop(); });
