#!/usr/bin/env node
/**
 * generate-media.js
 *
 * Headless-safe media generator for autonomous Paperclip CMO workflows.
 * Backends:
 *   - fal.ai (default): queue + direct fallback for current response-url behavior
 *   - Higgsfield: Cloud REST text-to-image backend for image assets
 *
 * Usage:
 *   node generate-media.js --brief /path/to/brief.json [--backend fal|higgsfield]
 */

import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import os from 'node:os';

const HOME = process.env.HOME || os.homedir();
const OPENCLAW_SECRETS_DIR = path.join(HOME, '.openclaw', 'secrets');

const FORBIDDEN = [
  'Skillboss', 'OpenAI', 'Claude', 'Anthropic', 'OpenRouter', 'Gemini', 'Veo',
  'Synthflow', 'ElevenLabs', 'GoHighLevel', 'Zapier', 'Docker', 'Tailscale', 'Mac Mini'
];

const DEFAULT_FAL_MODELS = {
  image: 'fal-ai/fast-sdxl',
  video: 'fal-ai/kling-video/v2.1/standard/text-to-video',
  'image-to-video': 'fal-ai/kling-video/v2.1/standard/image-to-video',
};

const DEFAULT_HIGGSFIELD_MODELS = {
  image: 'flux-pro/kontext/max/text-to-image',
};

function getArg(name, fallback = null) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

function readJsonIfExists(file) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {}
  return null;
}

function loadFalKey() {
  if (process.env.FAL_KEY) return process.env.FAL_KEY;
  const data = readJsonIfExists(path.join(OPENCLAW_SECRETS_DIR, 'fal.json'));
  if (data?.FAL_KEY) return data.FAL_KEY;
  if (data?.api_key) return data.api_key;
  if (data?.key) return data.key;

  const irtEnv = path.join(HOME, 'IRT-socialmedia', '.env');
  try {
    if (fs.existsSync(irtEnv)) {
      const match = fs.readFileSync(irtEnv, 'utf8').match(/^FAL_KEY=(.+)$/m);
      if (match) return match[1].trim().replace(/^["']|["']$/g, '');
    }
  } catch (_) {}
  return null;
}

function loadHiggsfieldCredentials() {
  if (process.env.HF_CREDENTIALS) return process.env.HF_CREDENTIALS;
  if (process.env.HF_KEY) return process.env.HF_KEY;
  if (process.env.HF_API_KEY && process.env.HF_API_SECRET) return `${process.env.HF_API_KEY}:${process.env.HF_API_SECRET}`;

  const data = readJsonIfExists(path.join(OPENCLAW_SECRETS_DIR, 'higgsfield.json'));
  if (data?.HF_CREDENTIALS) return data.HF_CREDENTIALS;
  if (data?.HF_KEY) return data.HF_KEY;
  if (data?.HF_API_KEY && data?.HF_API_SECRET) return `${data.HF_API_KEY}:${data.HF_API_SECRET}`;
  return null;
}

function loadBrief() {
  const briefPath = getArg('brief');
  if (!briefPath) throw new Error('Usage: node generate-media.js --brief /path/to/brief.json [--backend fal|higgsfield]');
  return JSON.parse(fs.readFileSync(briefPath, 'utf8'));
}

function validateBrief(brief) {
  const mode = brief.asset_type;
  if (!['image', 'video', 'image-to-video'].includes(mode)) throw new Error(`asset_type must be image|video|image-to-video (got ${mode})`);
  if (!brief.prompt || brief.prompt.length < 20) throw new Error('prompt is required and must be substantive');
  if (!brief.output) throw new Error('output path is required');
  if (mode === 'image-to-video' && !brief.image) throw new Error('image-to-video requires "image" (url or local path)');

  const text = [brief.prompt, brief.caption, brief.public_copy, brief.onscreen_text].filter(Boolean).join(' ');
  const hits = FORBIDDEN.filter(t => new RegExp(t, 'i').test(text));
  if (hits.length) throw new Error(`Forbidden vendor term(s) in public fields: ${hits.join(', ')}`);
}

function safeJsonParse(data, context) {
  try { return JSON.parse(data || '{}'); }
  catch (err) { throw new Error(`${context} returned non-JSON: ${String(data).slice(0, 200)}`); }
}

function requestJson(method, url, { apiKey, authHeader, body, timeoutMs = 30000 } = {}) {
  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const headers = { 'User-Agent': 'nbos-cmo-media-generator/1.1' };
    if (apiKey) headers.Authorization = `Key ${apiKey}`;
    if (authHeader) headers.Authorization = authHeader;
    if (payload !== null) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = https.request(url, { method, headers, timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        const parsed = data ? safeJsonParse(data, `${method} ${url}`) : {};
        if (res.statusCode >= 200 && res.statusCode < 300) resolve({ statusCode: res.statusCode, body: parsed, raw: data });
        else reject(new Error(`${method} ${url} HTTP ${res.statusCode}: ${data.slice(0, 500)}`));
      });
    });
    req.on('timeout', () => req.destroy(new Error(`${method} ${url} timed out`)));
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

function getJson(url, opts = {}) { return requestJson('GET', url, opts).then(r => r.body); }
function postJson(url, body, opts = {}) { return requestJson('POST', url, { ...opts, body }).then(r => r.body); }

async function downloadFile(url, dest) {
  const outPath = path.resolve(dest);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(outPath);
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      try { file.destroy(); } catch (_) {}
      reject(err);
    };
    file.on('error', fail);
    https.get(url, (res) => {
      if (res.statusCode !== 200) {
        fail(new Error(`Download failed ${res.statusCode} for ${url}`));
        return;
      }
      res.on('error', fail);
      res.pipe(file);
      file.on('finish', () => {
        if (settled) return;
        settled = true;
        file.close(resolve);
      });
    }).on('error', fail);
  });
}

function falInput(brief) {
  const mode = brief.asset_type;
  const input = { prompt: brief.prompt };
  if (mode === 'image') {
    input.image_size = brief.size || brief.image_size || 'landscape_16_9';
    input.num_images = Number(brief.num_images || 1);
  }
  if (mode === 'video' || mode === 'image-to-video') {
    input.duration = String(brief.duration || '5');
    input.aspect_ratio = brief.aspect_ratio || '16:9';
  }
  if (mode === 'image-to-video') {
    if (!brief.image || !String(brief.image).startsWith('http')) {
      throw new Error(
        `image-to-video requires a publicly accessible URL for "image"; local path "${brief.image}" cannot be sent to the fal.ai API. ` +
        `Upload the file first and provide the remote URL.`
      );
    }
    input.image_url = brief.image;
  }
  return input;
}

function extractAssetUrl(result) {
  if (!result || typeof result !== 'object') return '';
  return result.images?.[0]?.url ||
    result.image?.url ||
    result.video?.url ||
    result.output?.url ||
    result.outputs?.[0]?.url ||
    result.artifacts?.[0]?.url ||
    result.data?.images?.[0]?.url ||
    result.data?.image?.url ||
    result.data?.video?.url ||
    '';
}

async function getFalQueuedResult({ model, submitted, apiKey }) {
  const requestId = submitted.request_id;
  const statusUrl = submitted.status_url || `https://queue.fal.run/${model}/requests/${requestId}/status`;
  const candidates = [
    submitted.response_url,
    submitted.response_url && submitted.response_url.endsWith('/response') ? submitted.response_url : `${submitted.response_url || `https://queue.fal.run/${model}/requests/${requestId}`}/response`,
    `https://queue.fal.run/${model}/requests/${requestId}`,
  ].filter(Boolean);

  let lastStatus = null;
  for (let i = 0; i < 180; i++) {
    await new Promise(r => setTimeout(r, 5000));
    lastStatus = await getJson(statusUrl, { apiKey, timeoutMs: 20000 });
    process.stdout.write('.');
    if (lastStatus.status === 'COMPLETED') break;
    if (lastStatus.status === 'FAILED') throw new Error(`fal job failed: ${JSON.stringify(lastStatus.error || lastStatus)}`);
  }
  process.stdout.write('\n');
  if (!lastStatus || lastStatus.status !== 'COMPLETED') throw new Error('fal job timed out');

  for (const url of candidates) {
    try {
      const result = await getJson(url, { apiKey, timeoutMs: 30000 });
      if (extractAssetUrl(result)) return { result, transport: 'queue', response_url: url };
    } catch (_) {
      // Fal response URL behavior has changed across model families; try next candidate.
    }
  }

  return { result: null, transport: 'queue-no-result', response_url: candidates[0], lastStatus };
}

async function generateFal(brief) {
  const apiKey = loadFalKey() || getArg('fal-key');
  if (!apiKey) throw new Error('FAL_KEY not set (env, secret file, or --fal-key).');
  if (apiKey.includes('REPLACE')) throw new Error('FAL_KEY contains placeholder.');

  const mode = brief.asset_type;
  const model = brief.model || DEFAULT_FAL_MODELS[mode];
  const input = falInput(brief);

  const submitted = await postJson(`https://queue.fal.run/${model}`, input, { apiKey });
  let queued = null;
  if (submitted.request_id) queued = await getFalQueuedResult({ model, submitted, apiKey });

  // Some Fal model families currently advertise queue completion but do not expose a GET-able response
  // at the documented URL shape. For images, fall back to direct fal.run so autonomous CMO does not hang.
  let result = queued?.result;
  let transport = queued?.transport || 'queue';
  if (!extractAssetUrl(result) && mode === 'image') {
    result = await postJson(`https://fal.run/${model}`, input, { apiKey, timeoutMs: 120000 });
    transport = 'direct-fallback';
  }
  return { result, model, request_id: submitted.request_id || null, source: 'fal.ai', transport };
}

function higgsfieldInput(brief) {
  if (brief.asset_type !== 'image') throw new Error('Higgsfield backend currently supports image assets only.');
  return {
    prompt: brief.prompt,
    aspect_ratio: brief.aspect_ratio || (String(brief.size || '').includes('9_16') ? '9:16' : '16:9'),
  };
}

async function generateHiggsfield(brief) {
  const credentials = loadHiggsfieldCredentials() || getArg('higgsfield-key');
  if (!credentials || !credentials.includes(':')) throw new Error('HF_CREDENTIALS missing. Set HF_CREDENTIALS="KEY_ID:KEY_SECRET" or use --higgsfield-key.');
  if (credentials.includes('REPLACE')) throw new Error('Higgsfield credentials contain placeholder.');

  const model = brief.model || DEFAULT_HIGGSFIELD_MODELS[brief.asset_type];
  const baseURL = (brief.higgsfield_base_url || getArg('higgsfield-base-url', 'https://platform.higgsfield.ai')).replace(/\/$/, '');
  const submitted = await postJson(`${baseURL}/${model.replace(/^\//, '')}`, higgsfieldInput(brief), {
    authHeader: `Key ${credentials}`,
    timeoutMs: 30000,
  });

  const requestId = submitted.request_id || null;
  const statusUrl = submitted.status_url || (requestId ? `${baseURL}/requests/${requestId}/status` : null);
  let result = submitted;
  if (statusUrl) {
    for (let i = 0; i < 120; i++) {
      result = await getJson(statusUrl, { authHeader: `Key ${credentials}`, timeoutMs: 20000 });
      const status = String(result.status || result.state || '').toLowerCase();
      if (['completed', 'complete', 'succeeded', 'success', 'done'].includes(status)) break;
      if (['failed', 'error'].includes(status)) throw new Error(`Higgsfield job failed: ${JSON.stringify(result).slice(0, 500)}`);
      await new Promise(r => setTimeout(r, 5000));
      process.stdout.write('.');
    }
    process.stdout.write('\n');
  }
  return { result, model: `higgsfield/${model}`, request_id: requestId, source: 'Higgsfield', transport: 'cloud-api' };
}

async function generate(brief) {
  const start = Date.now();
  const backend = (getArg('backend') || brief.backend || brief.provider || 'fal').toLowerCase();
  const engine = backend === 'higgsfield' || backend === 'hf'
    ? await generateHiggsfield(brief)
    : await generateFal(brief);

  const assetUrl = extractAssetUrl(engine.result);
  if (!assetUrl) throw new Error(`Could not find asset URL in ${engine.source} result: ${JSON.stringify(engine.result).slice(0, 500)}`);

  const outPath = path.resolve(brief.output);
  await downloadFile(assetUrl, outPath);

  const proof = {
    generated_at: new Date().toISOString(),
    duration_ms: Date.now() - start,
    model: engine.model,
    asset_type: brief.asset_type,
    request_id: engine.request_id,
    output: outPath,
    prompt_hash: Buffer.from(brief.prompt).toString('base64').slice(0, 16),
    source: engine.source,
    transport: engine.transport,
    proof_version: '1.1',
  };
  const proofPath = outPath + '.proof.json';
  fs.writeFileSync(proofPath, JSON.stringify(proof, null, 2));
  return { output: outPath, proof: proofPath, result: proof };
}

async function main() {
  try {
    const brief = loadBrief();
    validateBrief(brief);
    const { output, proof, result } = await generate(brief);
    console.log(JSON.stringify({ status: 'success', output, proof, result }, null, 2));
  } catch (err) {
    console.error('GENERATE_FAILED:', err.message);
    process.exit(1);
  }
}

main();
