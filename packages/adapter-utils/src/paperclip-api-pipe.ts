import { execFile } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { isSafeBridgeMethod } from "./bridge-transport-contract.js";

const exec = promisify(execFile);
const REQUEST_LIMIT = 4096;
const RESPONSE_LIMIT = 512 * 1024;
const TIMEOUT_MS = 30_000;
const POLL_MS = 25;
const MAX_IN_FLIGHT = 8;
const REQUEST_PIPE = "requests.fifo";
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function equalCapability(actual: unknown, expected: string): boolean {
  if (typeof actual !== "string") return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

const delay = () => new Promise<void>((resolve) => setTimeout(resolve, POLL_MS));

function responseHeaders(response: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const key of ["content-type", "etag", "last-modified", "location", "x-request-id", "x-paperclip-bridge-outcome"]) {
    const value = response.headers.get(key);
    if (value) headers[key] = value;
  }
  return headers;
}

export interface PaperclipApiPipeBridge {
  env: { PAPERCLIP_API_BROKER_PIPE: string };
  stop(): Promise<void>;
}

/**
 * Run-scoped local transport for Paperclip's own API when a Codex command
 * sandbox blocks every AF_INET socket, including loopback. Requests and
 * responses stay in kernel FIFO buffers; the real run token never lands in a
 * launcher file or a response frame.
 */
export async function startPaperclipApiPipeBridge(input: {
  directory: string;
  apiUrl: string;
  apiToken: string;
  runId: string;
}): Promise<PaperclipApiPipeBridge> {
  if (process.platform !== "linux" || !input.apiToken.trim() || !input.runId.trim()) {
    throw new Error("Local Paperclip API pipes require Linux, a run API token, and a run ID");
  }
  const origin = new URL(input.apiUrl);
  if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password || origin.search || origin.hash) {
    throw new Error("Invalid Paperclip API URL");
  }
  const directory = await fs.mkdtemp(path.join(await fs.realpath(input.directory), "paperclip-api-pipe-"));
  await fs.chmod(directory, 0o700);
  let requestPipe: Awaited<ReturnType<typeof fs.open>>;
  try {
    await exec("/usr/bin/mkfifo", ["-m", "600", path.join(directory, REQUEST_PIPE)], { timeout: 5_000 });
    requestPipe = await fs.open(
      path.join(directory, REQUEST_PIPE),
      constants.O_RDWR | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
    if (!(await requestPipe.stat()).isFIFO()) {
      await requestPipe.close();
      throw new Error("Invalid Paperclip API request pipe");
    }
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pumpPromise: Promise<void> | undefined;
  const abort = new AbortController();
  const inFlight = new Map<string, Promise<void>>();
  let buffered = "";
  let discardUntilNewline = false;

  async function writeReply(id: string, status: number, headers: Record<string, string>, body: Buffer): Promise<void> {
    const frame = Buffer.from(JSON.stringify({ status, headers, body: body.toString("base64") }) + "\n");
    if (frame.length > RESPONSE_LIMIT || stopped) return;
    const reply = await fs.open(
      path.join(directory, `${id}.fifo`),
      constants.O_WRONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
    try {
      if (!(await reply.stat()).isFIFO()) return;
      const deadline = Date.now() + TIMEOUT_MS;
      let offset = 0;
      while (!stopped && offset < frame.length && Date.now() < deadline) {
        try {
          const { bytesWritten } = await reply.write(frame, offset, frame.length - offset);
          offset += bytesWritten;
          if (bytesWritten === 0) await delay();
        } catch (error) {
          if (!isErrno(error, "EAGAIN")) throw error;
          await delay();
        }
      }
    } finally {
      await reply.close();
    }
  }

  async function dispatch(id: string, frame: Record<string, unknown>): Promise<void> {
    if (frame.version !== 1 || !equalCapability(frame.capability, input.apiToken)) {
      await writeReply(id, 403, { "content-type": "application/json" }, Buffer.from('{"error":"Invalid Paperclip runtime capability"}'));
      return;
    }
    const request = frame.request;
    if (!request || typeof request !== "object" || Array.isArray(request)) {
      await writeReply(id, 400, { "content-type": "application/json" }, Buffer.from('{"error":"Invalid Paperclip API pipe request"}'));
      return;
    }
    const raw = request as Record<string, unknown>;
    const method = typeof raw.method === "string" ? raw.method.toUpperCase() : "GET";
    const requestPath = typeof raw.path === "string" ? raw.path : "";
    if (!METHODS.has(method) || !requestPath.startsWith("/api/") || requestPath.startsWith("//")) {
      await writeReply(id, 400, { "content-type": "application/json" }, Buffer.from('{"error":"Invalid Paperclip API route"}'));
      return;
    }
    const url = new URL(requestPath, origin);
    if (url.origin !== origin.origin || !url.pathname.startsWith("/api/")) {
      await writeReply(id, 400, { "content-type": "application/json" }, Buffer.from('{"error":"Invalid Paperclip API origin"}'));
      return;
    }
    const suppliedHeaders = raw.headers && typeof raw.headers === "object" && !Array.isArray(raw.headers)
      ? raw.headers as Record<string, unknown>
      : {};
    const headers = new Headers();
    const forwardedHeaderNames = new Set(["accept", "content-type", "if-match", "if-none-match", "idempotency-key", "prefer"]);
    for (const [key, value] of Object.entries(suppliedHeaders)) {
      const normalized = key.toLowerCase();
      if (!forwardedHeaderNames.has(normalized)) continue;
      if (typeof value === "string" && !/[\r\n]/.test(value)) headers.set(normalized, value);
    }
    if (raw.authenticated === true) headers.set("authorization", `Bearer ${input.apiToken}`);
    headers.set("x-paperclip-run-id", input.runId);
    let body: Buffer | undefined;
    if (typeof raw.body === "string" && raw.body.length > 0) {
      body = Buffer.from(raw.body, "base64");
      if (body.byteLength > REQUEST_LIMIT) {
        await writeReply(id, 413, { "content-type": "application/json" }, Buffer.from('{"error":"Paperclip API request body is too large"}'));
        return;
      }
    }
    try {
      const response = await fetch(url, {
        method,
        redirect: "manual",
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(TIMEOUT_MS)]),
        headers,
        ...(body && method !== "GET" && method !== "HEAD" ? { body: new Uint8Array(body) } : {}),
      });
      const responseBody = Buffer.from(await response.arrayBuffer());
      if (responseBody.byteLength > RESPONSE_LIMIT / 2) {
        const status = isSafeBridgeMethod(method) ? 502 : 409;
        const headers = {
          "content-type": "application/json",
          ...(status === 409 ? { "x-paperclip-bridge-outcome": "indeterminate" } : {}),
        };
        await writeReply(id, status, headers, Buffer.from(JSON.stringify({
          error: "Paperclip API response is too large",
          ...(status === 409 ? { outcome: "indeterminate", retryable: false } : {}),
        })));
        return;
      }
      await writeReply(id, response.status, responseHeaders(response), responseBody);
    } catch {
      const status = isSafeBridgeMethod(method) ? 502 : 409;
      const headers = {
        "content-type": "application/json",
        ...(status === 409 ? { "x-paperclip-bridge-outcome": "indeterminate" } : {}),
      };
      await writeReply(id, status, headers, Buffer.from(JSON.stringify({
        error: "Paperclip API transport unavailable",
        ...(status === 409 ? { outcome: "indeterminate", retryable: false } : {}),
      })));
    }
  }

  async function pump(): Promise<void> {
    const chunk = Buffer.alloc(REQUEST_LIMIT);
    try {
      const { bytesRead } = await requestPipe.read(chunk, 0, chunk.length, null);
      buffered += chunk.subarray(0, bytesRead).toString("utf8");
      let newline: number;
      let processed = 0;
      while ((newline = buffered.indexOf("\n")) !== -1) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (discardUntilNewline) {
          discardUntilNewline = false;
          continue;
        }
        if (++processed > MAX_IN_FLIGHT || line.length >= REQUEST_LIMIT || inFlight.size >= MAX_IN_FLIGHT) continue;
        let request: Record<string, unknown>;
        try {
          request = JSON.parse(line);
        } catch {
          continue;
        }
        if (typeof request.id !== "string" || !ID_PATTERN.test(request.id) || inFlight.has(request.id)) continue;
        const id = request.id;
        const operation = dispatch(id, request).catch(() => {}).finally(() => inFlight.delete(id));
        inFlight.set(id, operation);
      }
      if (buffered.length >= REQUEST_LIMIT) {
        buffered = "";
        discardUntilNewline = true;
      }
    } catch (error) {
      if (!stopped && !isErrno(error, "EAGAIN")) {
        stopped = true;
        abort.abort();
      }
    }
    if (!stopped) timer = setTimeout(() => { pumpPromise = pump(); }, POLL_MS);
  }

  pumpPromise = pump();
  let stopPromise: Promise<void> | undefined;
  return {
    env: { PAPERCLIP_API_BROKER_PIPE: directory },
    stop() {
      return stopPromise ??= (async () => {
        stopped = true;
        clearTimeout(timer);
        abort.abort();
        await pumpPromise;
        await Promise.allSettled(inFlight.values());
        await requestPipe.close();
        await fs.rm(directory, { recursive: true, force: true });
      })();
    },
  };
}

/** A narrow curl-compatible launcher for the documented Paperclip API calls. */
export function paperclipCurlLauncherSource(): string {
  return String.raw`#!/usr/bin/env node
// Paperclip managed control-plane curl launcher
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const directory = path.dirname(fs.realpathSync(process.argv[1]));
const args = process.argv.slice(2);
const debug = process.env.PAPERCLIP_API_BRIDGE_DEBUG === '1'
  ? (message) => process.stderr.write('[paperclip-api-bridge] ' + message + '\n')
  : () => {};
function realCurl() {
  for (const root of (process.env.PATH || '').split(path.delimiter)) {
    if (!root || path.resolve(root) === directory) continue;
    const candidate = path.join(root, 'curl');
    try { if (fs.statSync(candidate).isFile() && fs.accessSync(candidate, fs.constants.X_OK) === undefined) return candidate; } catch {}
  }
  return null;
}
function fallback() {
  const executable = realCurl();
  if (!executable) { process.stderr.write('curl: command not found\n'); process.exit(127); }
  const child = spawn(executable, args, { stdio: 'inherit', env: process.env });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));
  child.once('error', () => { process.exitCode = 1; });
  child.once('exit', (code) => { process.exitCode = code == null ? 1 : code; });
}
function takeValue(index, inline) {
  if (inline !== undefined) return [inline, index];
  if (index + 1 >= args.length) return null;
  return [args[index + 1], index + 1];
}
async function main() {
  const root = process.env.PAPERCLIP_API_BROKER_PIPE;
  const apiUrl = process.env.PAPERCLIP_API_URL;
  const capability = process.env.PAPERCLIP_API_KEY;
  if (!root || !apiUrl || !capability) return fallback();
  debug('bridge environment present');
  let method = 'GET', urlText = '', output = null, writeOut = '', fail = false, include = false;
  const headers = {}, data = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (/^-[sS]+$/.test(arg) || arg === '--silent' || arg === '--show-error') continue;
    if (arg === '-f' || arg === '--fail' || arg === '--fail-with-body') { fail = true; continue; }
    if (arg === '-i' || arg === '--include') { include = true; continue; }
    if (arg === '-I' || arg === '--head') { method = 'HEAD'; include = true; continue; }
    const option = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
    const inline = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : undefined;
    if (['-X', '--request', '-H', '--header', '-d', '--data', '--data-raw', '--data-binary', '-o', '--output', '-w', '--write-out'].includes(option)) {
      const taken = takeValue(i, inline); if (!taken) return fallback();
      const value = taken[0]; i = taken[1];
      if (option === '-X' || option === '--request') method = value.toUpperCase();
      else if (option === '-H' || option === '--header') {
        const split = value.indexOf(':'); if (split < 1) return fallback();
        headers[value.slice(0, split).trim().toLowerCase()] = value.slice(split + 1).trim();
      } else if (option === '-o' || option === '--output') output = value;
      else if (option === '-w' || option === '--write-out') writeOut = value;
      else data.push(value);
      continue;
    }
    if (arg === '--compressed' || arg === '--no-progress-meter') continue;
    if (arg.startsWith('-')) return fallback();
    if (urlText) return fallback();
    urlText = arg;
  }
  let requested, base;
  try { requested = new URL(urlText); base = new URL(apiUrl); } catch { return fallback(); }
  if (requested.origin !== base.origin || !requested.pathname.startsWith('/api/')) return fallback();
  debug('Paperclip URL matched');
  let body = '';
  for (const value of data) {
    let part = value;
    if (value === '@-') part = fs.readFileSync(0, 'utf8');
    else if (value.startsWith('@')) part = fs.readFileSync(value.slice(1), 'utf8');
    body += part;
  }
  if (data.length > 0 && method === 'GET') method = 'POST';
  const authorization = headers.authorization || '';
  delete headers.authorization;
  const authenticated = authorization === 'Bearer ' + capability;
  const id = randomUUID();
  const replyPath = path.join(root, id + '.fifo');
  const created = require('node:child_process').spawnSync('/usr/bin/mkfifo', ['-m', '600', replyPath], { stdio: 'ignore', timeout: 5000 });
  if (created.error || created.status !== 0) throw new Error('Paperclip API reply pipe unavailable');
  let reply, request;
  try {
    reply = fs.openSync(replyPath, fs.constants.O_RDWR | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
    if (!fs.fstatSync(reply).isFIFO()) throw new Error('Invalid Paperclip API reply pipe');
    const frame = Buffer.from(JSON.stringify({ version: 1, id, capability, request: {
      method, path: requested.pathname + requested.search, headers, authenticated,
      body: body ? Buffer.from(body).toString('base64') : '',
    } }) + '\n');
    if (frame.length > ${REQUEST_LIMIT}) throw new Error('Paperclip API request exceeds transport limit');
    request = fs.openSync(path.join(root, '${REQUEST_PIPE}'), fs.constants.O_WRONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
    if (!fs.fstatSync(request).isFIFO()) throw new Error('Invalid Paperclip API request pipe');
    if (fs.writeSync(request, frame) !== frame.length) throw new Error('Incomplete Paperclip API request');
    debug('request frame written');
    fs.closeSync(request); request = undefined;
    const deadline = Date.now() + ${TIMEOUT_MS};
    const chunk = Buffer.alloc(8192), chunks = [];
    let length = 0, result;
    while (Date.now() < deadline) {
      try {
        const count = fs.readSync(reply, chunk, 0, chunk.length, null);
        if (count) {
          length += count; if (length > ${RESPONSE_LIMIT}) throw new Error('Paperclip API response exceeds transport limit');
          chunks.push(Buffer.from(chunk.subarray(0, count)));
          if (chunk.subarray(0, count).includes(10)) { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); break; }
        }
      } catch (error) { if (error.code !== 'EAGAIN') throw error; }
      await new Promise(resolve => setTimeout(resolve, ${POLL_MS}));
    }
    if (!result || !Number.isInteger(result.status)) throw new Error('Paperclip API pipe timed out');
    const responseBody = Buffer.from(result.body || '', 'base64');
    debug('response received status=' + result.status + ' bytes=' + responseBody.length);
    let prefix = '';
    if (include) {
      prefix = 'HTTP/1.1 ' + result.status + '\r\n';
      for (const [key, value] of Object.entries(result.headers || {})) prefix += key + ': ' + value + '\r\n';
      prefix += '\r\n';
    }
    if (!(fail && result.status >= 400)) {
      const payload = Buffer.concat([Buffer.from(prefix), responseBody]);
      if (output && output !== '-') fs.writeFileSync(output, payload);
      else fs.writeSync(1, payload);
    }
    if (writeOut) fs.writeSync(1, writeOut.replaceAll('%{http_code}', String(result.status)).replaceAll('\\n', '\n'));
    if (fail && result.status >= 400) process.exitCode = 22;
  } finally {
    if (request !== undefined) fs.closeSync(request);
    if (reply !== undefined) fs.closeSync(reply);
    try { fs.unlinkSync(replyPath); } catch {}
  }
}
main().catch(() => { process.stderr.write('curl: Paperclip API pipe failed\n'); process.exitCode = 7; });
`;
}
