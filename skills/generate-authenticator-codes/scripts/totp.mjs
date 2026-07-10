#!/usr/bin/env node

import { createHmac } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const SUPPORTED_ALGORITHMS = new Map([
  ["SHA1", "sha1"],
  ["SHA256", "sha256"],
  ["SHA512", "sha512"],
]);

function fail(message) {
  throw new Error(message);
}

function positiveInteger(value, label) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) fail(`${label} must be a positive integer`);
  return parsed;
}

export function decodeBase32(input) {
  const normalized = String(input)
    .toUpperCase()
    .replace(/[\s-]+/g, "")
    .replace(/=+$/g, "");
  if (!normalized) fail("TOTP secret is empty");

  let bits = 0;
  let bitCount = 0;
  const bytes = [];
  for (const character of normalized) {
    const value = BASE32_ALPHABET.indexOf(character);
    if (value < 0) fail("TOTP secret is not valid Base32");
    bits = (bits << 5) | value;
    bitCount += 5;
    while (bitCount >= 8) {
      bitCount -= 8;
      bytes.push((bits >>> bitCount) & 0xff);
      bits &= (1 << bitCount) - 1;
    }
  }
  return Buffer.from(bytes);
}

function normalizeAlgorithm(value) {
  const normalized = String(value || "SHA1").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const algorithm = SUPPORTED_ALGORITHMS.get(normalized);
  if (!algorithm) fail(`Unsupported TOTP algorithm: ${value}`);
  return { label: normalized, nodeName: algorithm };
}

export function parseOtpAuthUri(input) {
  let uri;
  try {
    uri = new URL(String(input).trim());
  } catch {
    fail("Authenticator QR did not contain a valid otpauth URI");
  }
  if (uri.protocol !== "otpauth:" || uri.hostname.toLowerCase() !== "totp") {
    fail("Only otpauth://totp authenticator entries are supported");
  }

  const secret = uri.searchParams.get("secret");
  if (!secret) fail("Authenticator URI does not contain a secret");
  const digits = positiveInteger(uri.searchParams.get("digits") || 6, "digits");
  if (digits !== 6 && digits !== 8) fail("digits must be 6 or 8");
  const period = positiveInteger(uri.searchParams.get("period") || 30, "period");
  const algorithm = normalizeAlgorithm(uri.searchParams.get("algorithm") || "SHA1");

  return { secret, digits, period, algorithm: algorithm.label };
}

export function generateTotp({ secret, timestampMs = Date.now(), digits = 6, period = 30, algorithm = "SHA1" }) {
  const normalizedDigits = positiveInteger(digits, "digits");
  if (normalizedDigits !== 6 && normalizedDigits !== 8) fail("digits must be 6 or 8");
  const normalizedPeriod = positiveInteger(period, "period");
  const normalizedAlgorithm = normalizeAlgorithm(algorithm);
  const unixSeconds = Math.floor(Number(timestampMs) / 1000);
  if (!Number.isSafeInteger(unixSeconds) || unixSeconds < 0) fail("timestamp must be a valid date or Unix time");

  let counter = BigInt(Math.floor(unixSeconds / normalizedPeriod));
  const counterBuffer = Buffer.alloc(8);
  for (let index = 7; index >= 0; index -= 1) {
    counterBuffer[index] = Number(counter & 0xffn);
    counter >>= 8n;
  }

  const digest = createHmac(normalizedAlgorithm.nodeName, decodeBase32(secret))
    .update(counterBuffer)
    .digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  const code = String(binary % 10 ** normalizedDigits).padStart(normalizedDigits, "0");
  const secondsRemaining = normalizedPeriod - (unixSeconds % normalizedPeriod);
  return { code, secondsRemaining, digits: normalizedDigits, period: normalizedPeriod };
}

function parseTimestamp(value) {
  if (value === undefined) return Date.now();
  if (/^\d+$/.test(value)) {
    const numeric = Number(value);
    if (!Number.isSafeInteger(numeric)) fail("--at is outside the supported range");
    return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) fail("--at must be an ISO date or Unix timestamp");
  return parsed;
}

function decodeQrImage(imagePath) {
  const result = spawnSync("zbarimg", ["--quiet", "--raw", imagePath], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  if (result.error?.code === "ENOENT") {
    fail("zbarimg is unavailable; install the zbar-tools package in the agent runtime");
  }
  const candidates = String(result.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const otpUri = candidates.find((candidate) => candidate.toLowerCase().startsWith("otpauth://totp/"));
  if (!otpUri) fail("No TOTP authenticator QR code was found in the image");
  return otpUri;
}

function paperclipRequestHeaders() {
  const apiKey = process.env.PAPERCLIP_API_KEY?.trim();
  if (!apiKey) fail("PAPERCLIP_API_KEY is required to read a Paperclip attachment");
  return { Authorization: `Bearer ${apiKey}` };
}

function paperclipUrl(pathname) {
  const apiUrl = process.env.PAPERCLIP_API_URL?.trim();
  if (!apiUrl) fail("PAPERCLIP_API_URL is required to read a Paperclip attachment");
  return new URL(pathname, apiUrl.endsWith("/") ? apiUrl : `${apiUrl}/`);
}

async function fetchPaperclip(pathname) {
  const response = await fetch(paperclipUrl(pathname), { headers: paperclipRequestHeaders() });
  if (!response.ok) fail(`Paperclip attachment request failed with HTTP ${response.status}`);
  return response;
}

async function decodePaperclipAttachment(attachmentId, filename = null) {
  const response = await fetchPaperclip(`/api/attachments/${encodeURIComponent(attachmentId)}/content`);
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length === 0) fail("Paperclip attachment is empty");
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-totp-"));
  const extension = path.extname(filename || "") || ".img";
  const imagePath = path.join(tempRoot, `attachment${extension}`);
  try {
    await writeFile(imagePath, body, { mode: 0o600 });
    return decodeQrImage(imagePath);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function decodePaperclipIssue(issueId) {
  const response = await fetchPaperclip(`/api/issues/${encodeURIComponent(issueId)}/heartbeat-context`);
  const context = await response.json();
  const attachments = Array.isArray(context?.attachments) ? context.attachments : [];
  const images = attachments
    .filter((attachment) => String(attachment?.contentType || "").toLowerCase().startsWith("image/"))
    .sort((left, right) => Date.parse(right?.createdAt || 0) - Date.parse(left?.createdAt || 0));
  if (images.length === 0) fail("The Paperclip issue has no image attachments");

  for (const attachment of images) {
    try {
      const uri = await decodePaperclipAttachment(attachment.id, attachment.filename);
      return {
        uri,
        source: attachment.filename ? `Paperclip attachment ${attachment.filename}` : "Paperclip image attachment",
      };
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("No TOTP authenticator QR code")) throw error;
    }
  }
  fail("No TOTP authenticator QR code was found in the issue's image attachments");
}

function manualConfig(values) {
  if (!values.secret) fail("Provide one of --issue, --attachment, --image, --uri, or --secret");
  const digits = positiveInteger(values.digits || 6, "digits");
  if (digits !== 6 && digits !== 8) fail("digits must be 6 or 8");
  return {
    secret: values.secret,
    digits,
    period: positiveInteger(values.period || 30, "period"),
    algorithm: normalizeAlgorithm(values.algorithm || "SHA1").label,
  };
}

async function resolveInput(values) {
  const selected = [values.issue, values.attachment, values.image, values.uri, values.secret].filter(Boolean);
  if (selected.length !== 1) fail("Provide exactly one input: --issue, --attachment, --image, --uri, or --secret");

  if (values.issue) {
    const decoded = await decodePaperclipIssue(values.issue);
    return { config: parseOtpAuthUri(decoded.uri), source: decoded.source };
  }
  if (values.attachment) {
    const uri = await decodePaperclipAttachment(values.attachment);
    return { config: parseOtpAuthUri(uri), source: "Paperclip image attachment" };
  }
  if (values.image) {
    return { config: parseOtpAuthUri(decodeQrImage(path.resolve(values.image))), source: path.basename(values.image) };
  }
  if (values.uri) return { config: parseOtpAuthUri(values.uri), source: "otpauth URI" };
  return { config: manualConfig(values), source: "manual Base32 secret" };
}

async function main() {
  const { values } = parseArgs({
    options: {
      issue: { type: "string" },
      attachment: { type: "string" },
      image: { type: "string" },
      uri: { type: "string" },
      secret: { type: "string" },
      algorithm: { type: "string" },
      digits: { type: "string" },
      period: { type: "string" },
      at: { type: "string" },
      "min-validity": { type: "string", default: "8" },
      "code-only": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });

  if (values.help) {
    process.stdout.write(
      "Usage: totp.mjs (--issue ID | --attachment ID | --image FILE | --uri URI | --secret BASE32) [--algorithm SHA1|SHA256|SHA512] [--digits 6|8] [--period 30] [--min-validity 8] [--code-only]\n",
    );
    return;
  }

  const { config, source } = await resolveInput(values);
  const explicitTimestamp = values.at !== undefined;
  let timestampMs = parseTimestamp(values.at);
  const minValidity = Number.parseInt(values["min-validity"], 10);
  if (!Number.isSafeInteger(minValidity) || minValidity < 0 || minValidity >= config.period) {
    fail("--min-validity must be at least 0 and less than the TOTP period");
  }

  let result = generateTotp({ ...config, timestampMs });
  if (!explicitTimestamp && result.secondsRemaining <= minValidity) {
    await new Promise((resolve) => setTimeout(resolve, (result.secondsRemaining + 1) * 1000));
    timestampMs = Date.now();
    result = generateTotp({ ...config, timestampMs });
  }

  if (values["code-only"]) {
    process.stdout.write(`${result.code}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify({ ...result, source })}\n`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`authenticator error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
