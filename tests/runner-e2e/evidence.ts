import { spawn } from "node:child_process";
import {
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
  copyFile,
} from "node:fs/promises";
import path from "node:path";
import {
  assertSecretFree,
  findSecretLeak,
  findSecretLeakInJsonValues,
  redactText,
  sanitizeJson,
} from "./redaction.js";

const TEXT_EXTENSIONS = new Set([
  ".json",
  ".xml",
  ".html",
  ".css",
  ".js",
  ".txt",
  ".log",
  ".md",
]);
const BINARY_EXTENSIONS = new Set([".png", ".webm"]);
const ACTIVE_CONTENT_EXTENSIONS = new Set([".svg"]);
const ALLOWED_DIRECTORIES = new Set([
  "snapshots",
  "playwright-output",
  "blob-report",
  "html-report",
]);
const ALLOWED_ROOT_FILES = new Set([
  "result.json",
  "final-state.png",
  "failure.png",
  "server.log",
  "playwright.log",
  "junit.xml",
]);
const REQUIRED_PASS_FILES = [
  "final-state.png",
  "result.json",
  "junit.xml",
  path.join("html-report", "index.html"),
  path.join("snapshots", "fixtures.json"),
  path.join("snapshots", "api-state.json"),
] as const;

export interface EvidencePackageResult {
  files: string[];
  leaks: Array<{ file: string; reason: string }>;
  missing: string[];
}

async function walk(root: string, relative = ""): Promise<string[]> {
  const directory = path.join(root, relative);
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    () => [],
  );
  const files: string[] = [];
  for (const entry of entries) {
    const next = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(root, next)));
    else if (entry.isFile()) files.push(next);
  }
  return files;
}

function isAllowed(relative: string) {
  const segments = relative.split(path.sep);
  if (segments.length === 1)
    return (
      ALLOWED_ROOT_FILES.has(relative) ||
      /^(?:plan|question)-[a-z0-9-]+\.png$/.test(relative)
    );
  return ALLOWED_DIRECTORIES.has(segments[0]);
}

async function inspectZip(source: string, secrets: readonly string[]) {
  // Failure traces can exceed Node's child-process output buffer. Stream the
  // expanded archive through the exact-value scanner with enough overlap to
  // detect a credential split across stdout chunks, without retaining the
  // archive in memory or weakening fail-closed evidence publication.
  const overlap = Math.max(
    256,
    ...secrets.map((secret) => Buffer.byteLength(secret, "utf8") + 16),
  );
  return new Promise<string | null>((resolve) => {
    const unzip = spawn("unzip", ["-p", source], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let carry = Buffer.alloc(0);
    let leak: string | null = null;
    let spawnError: Error | null = null;

    unzip.stdout.on("data", (chunk: Buffer) => {
      if (leak) return;
      const data = Buffer.concat([carry, chunk]);
      leak = findSecretLeak(data, secrets, { includeShapes: false });
      carry = data.subarray(Math.max(0, data.length - overlap));
      if (leak) unzip.kill();
    });
    // Drain diagnostics so a noisy unzip cannot block. Error text is withheld
    // because archive paths and contents belong to private attempt evidence.
    unzip.stderr.resume();
    unzip.on("error", (error) => {
      spawnError = error;
    });
    unzip.on("close", (code) => {
      if (leak) return resolve(leak);
      if (spawnError) {
        return resolve(`zip could not be inspected: ${spawnError.message}`);
      }
      return resolve(
        code === 0
          ? null
          : `zip could not be inspected: unzip exited with code ${String(code)}`,
      );
    });
  });
}

export async function packageEvidence(input: {
  privateDir: string;
  uploadDir: string;
  secrets: readonly string[];
  expectPassScreenshot: boolean;
}): Promise<EvidencePackageResult> {
  await rm(input.uploadDir, { recursive: true, force: true });
  await mkdir(input.uploadDir, { recursive: true });
  const files: string[] = [];
  const leaks: EvidencePackageResult["leaks"] = [];
  const available = await walk(input.privateDir);

  for (const relative of available.filter(isAllowed)) {
    const source = path.join(input.privateDir, relative);
    const extension = path.extname(relative).toLowerCase();
    const destination = path.join(input.uploadDir, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    if (ACTIVE_CONTENT_EXTENSIONS.has(extension)) {
      // SVG can execute script when opened directly from an artifact. Keep the
      // source in the disposable private attempt directory, but never admit it
      // to the sanitized CI artifact.
      continue;
    } else if (TEXT_EXTENSIONS.has(extension)) {
      const raw = await readFile(source, "utf8");
      const parsed = extension === ".json" ? JSON.parse(raw) : null;
      const leak =
        extension === ".json"
          ? findSecretLeakInJsonValues(parsed, input.secrets)
          : findSecretLeak(raw, input.secrets);
      if (leak) leaks.push({ file: relative, reason: leak });
      // Redacting an already serialized JSON string can change escape
      // boundaries around shell commands. Sanitize parsed values instead so
      // uploaded snapshots stay valid JSON.
      const safe =
        extension === ".json"
          ? `${JSON.stringify(sanitizeJson(parsed, input.secrets), null, 2)}\n`
          : redactText(raw, input.secrets);
      if (extension === ".json") {
        const safeLeak = findSecretLeakInJsonValues(
          JSON.parse(safe),
          input.secrets,
        );
        if (safeLeak)
          throw new Error(`Secret leak in ${relative}: ${safeLeak}`);
      } else {
        assertSecretFree(safe, input.secrets, relative);
      }
      await writeFile(destination, safe, "utf8");
      files.push(relative);
    } else if (extension === ".zip") {
      const leak = await inspectZip(source, input.secrets);
      if (leak) {
        leaks.push({ file: relative, reason: leak });
        continue;
      }
      await copyFile(source, destination);
      files.push(relative);
    } else if (BINARY_EXTENSIONS.has(extension)) {
      // This raw-byte scan catches embedded plaintext credentials, but cannot
      // inspect rendered pixels. Raster/video files are retained in the
      // access-controlled CI artifact and stripped at the public-history
      // boundary by history-publish.ts.
      const raw = await readFile(source);
      const leak = findSecretLeak(raw, input.secrets);
      if (leak) {
        leaks.push({ file: relative, reason: leak });
        continue;
      }
      await copyFile(source, destination);
      files.push(relative);
    }
  }

  const missing = input.expectPassScreenshot
    ? [
        ...REQUIRED_PASS_FILES.filter((required) => !files.includes(required)),
        ...(files.some(
          (file) =>
            file.startsWith(`blob-report${path.sep}`) && file.endsWith(".zip"),
        )
          ? []
          : [path.join("blob-report", "*.zip")]),
      ]
    : [];
  const manifest = {
    schema: "paperclip.runner-e2e.evidence/v1",
    files: [...files].sort(),
    leaks,
    missing,
  };
  const manifestText = `${JSON.stringify(sanitizeJson(manifest, input.secrets), null, 2)}\n`;
  const manifestLeak = findSecretLeakInJsonValues(
    JSON.parse(manifestText),
    input.secrets,
  );
  if (manifestLeak)
    throw new Error(`Secret leak in evidence-manifest.json: ${manifestLeak}`);
  await writeFile(
    path.join(input.uploadDir, "evidence-manifest.json"),
    manifestText,
    "utf8",
  );
  files.push("evidence-manifest.json");
  return { files, leaks, missing };
}
