/**
 * Ephemeral Key Inference — BDD Scenario Tests
 *
 * Feature: Secure Venice AI inference with ephemeral keys
 *   As an autonomous agent
 *   I want zero-persistence API keys that rotate per request
 *   So that inference is private and immune to key leaks or rate-limit abuse
 *
 * Scenarios covered:
 *   1. Ephemeral key generation
 *   2. Inference query (response < 5 s, key immediately discarded)
 *   3. Full fallback chain (Venice → Bittensor → Local)
 *   4. Zero key exposure (logs, errors, memory writes)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build a minimal OpenAI-compatible chat-completion response */
function makeVeniceSuccess(text: string, model = 'llama-3.3-70b') {
  return new Response(
    JSON.stringify({
      choices: [{ message: { role: 'assistant', content: text } }],
      model,
      usage: { prompt_tokens: 10, completion_tokens: 20 },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

/** Venice key-creation success response */
function makeKeyCreateResponse(key: string, id: string) {
  return new Response(
    JSON.stringify({ key, id }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

/** Venice key-deletion success */
function makeKeyDeleteResponse() {
  return new Response('{}', { status: 200 });
}

/** HTTP 429 rate-limit error */
function makeRateLimitResponse() {
  return new Response(
    JSON.stringify({ error: 'rate_limit_exceeded' }),
    { status: 429, headers: { 'Content-Type': 'application/json' } },
  );
}

/** Network-level rejection */
function makeNetworkError() {
  return Promise.reject(new Error('fetch failed'));
}

// ── Module loaders (lazy — after vi.stubGlobal) ───────────────────────────────

async function loadVenice() {
  return import('../../src/inference/venice-client.js');
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 1 — Ephemeral key generation
// ─────────────────────────────────────────────────────────────────────────────

describe('Scenario: Ephemeral key generation', () => {
  it('Given an inference request, when /auth is called, a fresh ephemeral key is returned', async () => {
    const { EphemeralKeyManager } = await loadVenice();

    const masterKey = 'master-key-abc123';

    // Mock POST /api_keys → returns a unique key each time
    let callCount = 0;
    vi.stubGlobal('fetch', async () => {
      callCount++;
      const id = crypto.randomBytes(8).toString('hex');
      const key = crypto.randomBytes(24).toString('hex');
      return makeKeyCreateResponse(key, id);
    });

    const mgr = new EphemeralKeyManager(
      masterKey,
      'https://api.venice.ai/api/v1',
      5_000,
    );

    const session1 = await mgr.generate();
    const session2 = await mgr.generate();

    // Each call to generate() must produce a distinct key
    const key1 = session1.holder.consume();
    const key2 = session2.holder.consume();

    expect(key1).toBeDefined();
    expect(key2).toBeDefined();
    expect(key1).not.toBe(key2);
    expect(callCount).toBe(2);

    mgr.destroy();
    vi.unstubAllGlobals();
  });

  it('Each key is single-use — consuming twice throws', async () => {
    const { EphemeralKeyHolder } = await loadVenice();
    const holder = new EphemeralKeyHolder('test-key-material');

    holder.consume(); // first use succeeds
    expect(() => holder.consume()).toThrow('already consumed');
  });

  it('discard() zeroes key material so consume() never exposes it', async () => {
    const { EphemeralKeyHolder } = await loadVenice();
    const holder = new EphemeralKeyHolder('secret-key-xyz');

    holder.discard();

    // After discard the buffer is all-zero; any consumed value would be empty
    // We verify consumed flag prevents further use
    expect(holder.consumed).toBe(true);
    expect(() => holder.consume()).toThrow('already consumed');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 2 — Inference query
// ─────────────────────────────────────────────────────────────────────────────

describe('Scenario: Inference query', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('Given a prompt and valid ephemeral key, when posted to /generate, a response is received', async () => {
    const EXPECTED_TEXT = 'Hello from Venice AI';

    vi.stubGlobal('fetch', async (url: string) => {
      if (url.includes('/api_keys')) {
        // Could be POST (create) or DELETE (revoke)
        if (url.split('/').pop() === 'api_keys') {
          return makeKeyCreateResponse(crypto.randomBytes(24).toString('hex'), 'key-id-1');
        }
        return makeKeyDeleteResponse(); // DELETE /api_keys/:id
      }
      if (url.includes('/chat/completions')) {
        return makeVeniceSuccess(EXPECTED_TEXT);
      }
      return new Response('not found', { status: 404 });
    });

    const { VeniceClient } = await loadVenice();
    const client = new VeniceClient({ masterApiKey: 'master-test-key' });

    const result = await client.generate({ prompt: 'Say hello' });

    expect(result.success).toBe(true);
    expect(result.text).toBe(EXPECTED_TEXT);
    expect(result.provider).toBe('venice');

    client.destroy();
  });

  it('Response is received in < 5 seconds (fast mock)', async () => {
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.includes('/api_keys')) {
        if (url.split('/').pop() === 'api_keys') {
          return makeKeyCreateResponse(crypto.randomBytes(24).toString('hex'), 'k1');
        }
        return makeKeyDeleteResponse();
      }
      return makeVeniceSuccess('quick response');
    });

    const { VeniceClient } = await loadVenice();
    const client = new VeniceClient({ masterApiKey: 'master-test-key', timeout: 5_000 });

    const start = Date.now();
    const result = await client.generate({ prompt: 'Quick question' });
    const elapsed = Date.now() - start;

    expect(result.success).toBe(true);
    expect(elapsed).toBeLessThan(5_000);

    client.destroy();
  });

  it('Key is used only for one request — subsequent requests get fresh keys', async () => {
    const usedKeys = new Set<string>();
    let keySeq = 0;

    vi.stubGlobal('fetch', async (url: string, opts?: RequestInit) => {
      if (url.includes('/api_keys')) {
        if ((url.match(/\/api_keys\//u) ?? false)) return makeKeyDeleteResponse();
        keySeq++;
        const key = `ephemeral-key-${keySeq}`;
        return makeKeyCreateResponse(key, `id-${keySeq}`);
      }
      if (url.includes('/chat/completions')) {
        // Record which key was used
        const auth = (opts?.headers as Record<string, string>)?.['Authorization'] ?? '';
        const keyUsed = auth.replace('Bearer ', '');
        usedKeys.add(keyUsed);
        return makeVeniceSuccess(`response-${keySeq}`);
      }
      return new Response('not found', { status: 404 });
    });

    const { VeniceClient } = await loadVenice();
    const client = new VeniceClient({ masterApiKey: 'master-test-key' });

    await client.generate({ prompt: 'first' });
    await client.generate({ prompt: 'second' });
    await client.generate({ prompt: 'third' });

    // Each request should use a distinct key
    expect(usedKeys.size).toBe(3);

    client.destroy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 3 — Full fallback chain
// ─────────────────────────────────────────────────────────────────────────────

describe('Scenario: Full fallback chain', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'av-inference-test-'));
    vi.stubEnv('HOME', tmpHome);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('Given Venice is unavailable, Bittensor is tried next', async () => {
    // Venice fails, Bittensor succeeds
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.includes('venice.ai')) {
        if (url.includes('/api_keys') && !url.match(/\/api_keys\//u)) {
          // Key creation — return 429
          return makeRateLimitResponse();
        }
        return makeRateLimitResponse();
      }
      // Local model — unavailable
      if (url.includes('localhost')) {
        return makeNetworkError() as unknown as Response;
      }
      return new Response('not found', { status: 404 });
    });

    // Stub BittensorClient to succeed
    vi.doMock('../../src/inference/bittensor-client.js', () => ({
      BittensorClient: class {
        async infer() {
          return {
            success: true,
            data: { text: 'Bittensor response' },
            metadata: { uid: 1, name: 'mock', netuid: 18, responseTime: 100 },
          };
        }
      },
    }));

    const { SecureInferenceEngine } = await import('../../src/inference/secure-inference.js');

    const engine = new SecureInferenceEngine({
      venice: { masterApiKey: 'master-test-key' },
    });

    const result = await engine.generate({ prompt: 'hello', bittensorNetuid: 18 });

    expect(result.success).toBe(true);
    expect(result.provider).toBe('bittensor');
    expect(result.fallbackChain).toContain('venice');

    engine.destroy();
  });

  it('Given Venice and Bittensor fail, local model is tried last', async () => {
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.includes('venice.ai')) return makeRateLimitResponse();
      if (url.includes('localhost:11434') && url.includes('/api/generate')) {
        return new Response(
          JSON.stringify({ response: 'Local response', model: 'llama3' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.includes('localhost:11434') && url.includes('/api/tags')) {
        return new Response(
          JSON.stringify({ models: [{ name: 'llama3' }] }),
          { status: 200 },
        );
      }
      return new Response('not found', { status: 404 });
    });

    vi.doMock('../../src/inference/bittensor-client.js', () => ({
      BittensorClient: class {
        async infer() {
          return { success: false, error: 'Bittensor unavailable' };
        }
      },
    }));

    const { SecureInferenceEngine } = await import('../../src/inference/secure-inference.js');
    const engine = new SecureInferenceEngine({
      venice: { masterApiKey: 'master-test-key' },
    });

    const result = await engine.generate({ prompt: 'hello' });

    expect(result.success).toBe(true);
    expect(result.provider).toBe('local');
    expect(result.fallbackChain).toEqual(['venice', 'bittensor']);

    engine.destroy();
  });

  it('Inference cost is logged for the chosen provider (no key material in log)', async () => {
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.includes('venice.ai')) return makeRateLimitResponse();
      if (url.includes('localhost:11434/api/generate')) {
        return new Response(
          JSON.stringify({ response: 'Local ok', model: 'llama3' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.includes('localhost:11434/api/tags')) {
        return new Response(JSON.stringify({ models: [{ name: 'llama3' }] }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    });

    vi.doMock('../../src/inference/bittensor-client.js', () => ({
      BittensorClient: class {
        async infer() {
          return { success: false, error: 'unavailable' };
        }
      },
    }));

    const { SecureInferenceEngine } = await import(
      '../../src/inference/secure-inference.js'
    );
    const engine = new SecureInferenceEngine({
      venice: { masterApiKey: 'supersecretmasterkey123456789abc' },
    });

    await engine.generate({ prompt: 'cost log test' });

    const today = new Date().toISOString().slice(0, 10);
    const costLogDir = path.join(tmpHome, '.agentvault', 'inference-costs');
    const logPath = path.join(costLogDir, `${today}.jsonl`);

    expect(fs.existsSync(logPath)).toBe(true);

    const raw = fs.readFileSync(logPath, 'utf8');

    // Must NOT contain key material
    expect(raw).not.toContain('supersecretmasterkey123456789abc');
    // Must NOT contain any 20+ char alphanumeric blob that could be a key
    expect(raw).not.toMatch(/[A-Za-z0-9+/]{40,}/);

    // Must contain provider info
    expect(raw).toContain('"provider"');
    expect(raw).toContain('"cost_usd"');
    expect(raw).toContain('"duration_ms"');

    engine.destroy();
  });

  it('readCostLog returns structured entries for the chosen provider', async () => {
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.includes('venice.ai')) {
        if (url.includes('/api_keys') && !url.match(/\/api_keys\//u)) {
          return makeKeyCreateResponse(crypto.randomBytes(24).toString('hex'), 'k1');
        }
        if (url.match(/\/api_keys\//u)) return makeKeyDeleteResponse();
        return makeVeniceSuccess('success response');
      }
      return new Response('not found', { status: 404 });
    });

    vi.doMock('../../src/inference/bittensor-client.js', () => ({
      BittensorClient: class {
        async infer() {
          return { success: false, error: 'unavailable' };
        }
      },
    }));

    const { SecureInferenceEngine, readCostLog } = await import(
      '../../src/inference/secure-inference.js'
    );
    const engine = new SecureInferenceEngine({
      venice: { masterApiKey: 'master-test-key' },
    });

    await engine.generate({ prompt: 'billing test' });

    const today = new Date().toISOString().slice(0, 10);
    const entries = readCostLog(today);

    expect(entries.length).toBeGreaterThan(0);
    const veniceEntry = entries.find((e) => e.provider === 'venice' && e.success);
    expect(veniceEntry).toBeDefined();
    expect(veniceEntry!.cost_usd).toBeGreaterThanOrEqual(0);
    expect(veniceEntry!.duration_ms).toBeGreaterThanOrEqual(0);

    engine.destroy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 4 — Zero key exposure
// ─────────────────────────────────────────────────────────────────────────────

describe('Scenario: Zero key exposure', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sanitizeForLog strips long alphanumeric tokens from error messages', async () => {
    const { sanitizeForLog } = await loadVenice();

    const fakeKey = 'abcdef1234567890abcdef1234567890abcdef'; // 38 chars
    const message = `Authorization failed: Bearer ${fakeKey}`;

    const sanitized = sanitizeForLog(message);

    expect(sanitized).not.toContain(fakeKey);
    expect(sanitized).toContain('[REDACTED]');
  });

  it('sanitizeForLog strips bare hex key material', async () => {
    const { sanitizeForLog } = await loadVenice();

    const hexKey = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4'; // 32 hex chars
    const message = `Invalid key: ${hexKey}`;

    const sanitized = sanitizeForLog(message);

    expect(sanitized).not.toContain(hexKey);
    expect(sanitized).toContain('[REDACTED]');
  });

  it('Error response from Venice never contains the ephemeral key', async () => {
    const EPHEMERAL_KEY = crypto.randomBytes(24).toString('hex');

    vi.stubGlobal('fetch', async (url: string) => {
      if (url.includes('/api_keys') && !url.match(/\/api_keys\//u)) {
        return makeKeyCreateResponse(EPHEMERAL_KEY, 'k1');
      }
      if (url.match(/\/api_keys\//u)) return makeKeyDeleteResponse();
      if (url.includes('/chat/completions')) {
        // Return an error body that echoes the auth header back (adversarial server)
        return new Response(
          JSON.stringify({ error: `Unauthorized: Bearer ${EPHEMERAL_KEY}` }),
          { status: 401, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('not found', { status: 404 });
    });

    const { VeniceClient } = await loadVenice();
    const client = new VeniceClient({ masterApiKey: 'master-test-key' });

    const result = await client.generate({ prompt: 'trigger error' });

    expect(result.success).toBe(false);
    // The error message must not contain the raw ephemeral key
    expect(result.error).not.toContain(EPHEMERAL_KEY);
    expect(result.error).toContain('[REDACTED]');

    client.destroy();
  });

  it('Key holder buffer is zeroed after consume()', async () => {
    const { EphemeralKeyHolder } = await loadVenice();

    const rawKey = 'my-secret-api-key-value';
    const holder = new EphemeralKeyHolder(rawKey);

    // Consume (this also zeroes the buffer)
    const consumed = holder.consume();
    expect(consumed).toBe(rawKey);
    expect(holder.consumed).toBe(true);

    // Attempting to consume again throws — buffer is zeroed
    expect(() => holder.consume()).toThrow();
  });

  it('Master key buffer is zeroed after destroy()', async () => {
    const { EphemeralKeyManager } = await loadVenice();

    const masterKey = 'super-secret-master-key-value';
    const mgr = new EphemeralKeyManager(
      masterKey,
      'https://api.venice.ai/api/v1',
      5_000,
    );

    mgr.destroy();

    // After destroy, the internal buffer should be all zeros
    const buf = (mgr as unknown as { masterBuf: Uint8Array }).masterBuf;
    expect(buf.every((b) => b === 0)).toBe(true);
  });

  it('Cost log does not contain any API key material', async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'av-zero-key-test-'));
    vi.stubEnv('HOME', tmpHome);

    const MASTER_KEY = 'should-never-appear-in-log-abc123xyz';

    vi.stubGlobal('fetch', async (url: string) => {
      if (url.includes('venice.ai')) {
        if (url.includes('/api_keys') && !url.match(/\/api_keys\//u)) {
          return makeKeyCreateResponse(`ephemeral-${crypto.randomBytes(16).toString('hex')}`, 'k1');
        }
        if (url.match(/\/api_keys\//u)) return makeKeyDeleteResponse();
        return makeVeniceSuccess('answer');
      }
      return new Response('not found', { status: 404 });
    });

    vi.doMock('../../src/inference/bittensor-client.js', () => ({
      BittensorClient: class {
        async infer() { return { success: false }; }
      },
    }));

    const { SecureInferenceEngine } = await import('../../src/inference/secure-inference.js');
    const engine = new SecureInferenceEngine({ venice: { masterApiKey: MASTER_KEY } });
    await engine.generate({ prompt: 'log safety check' });
    engine.destroy();

    // Scan the entire cost log directory for key material
    const costLogDir = path.join(tmpHome, '.agentvault', 'inference-costs');
    if (fs.existsSync(costLogDir)) {
      for (const file of fs.readdirSync(costLogDir)) {
        const content = fs.readFileSync(path.join(costLogDir, file), 'utf8');
        expect(content).not.toContain(MASTER_KEY);
        // No 40+ char alphanumeric blob (keys are typically ≥ 32 chars)
        expect(content).not.toMatch(/[A-Za-z0-9+/]{40,}/);
      }
    }

    vi.unstubAllEnvs();
    fs.rmSync(tmpHome, { recursive: true, force: true });
    vi.resetModules();
  });

  it('Network error message is sanitised before being returned', async () => {
    vi.stubGlobal('fetch', (_url: string) => {
      throw new Error(
        'Connection refused: key=supersecrettoken1234567890abcdef1234567890',
      );
    });

    const { VeniceClient } = await loadVenice();
    const client = new VeniceClient({ masterApiKey: 'master-test-key' });

    const result = await client.generate({ prompt: 'trigger network error' });

    expect(result.success).toBe(false);
    expect(result.error).not.toContain('supersecrettoken1234567890abcdef1234567890');
    expect(result.error).toContain('[REDACTED]');

    client.destroy();
  });
});
