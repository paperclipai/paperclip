import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import {
  cp,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { regenerateRunnerDashboard } from "./dashboard-regenerate.js";

const execFileAsync = promisify(execFile);
const PUBLIC_EVIDENCE_EXTENSIONS = new Set([".json", ".log", ".md", ".txt"]);
const PRIVATE_EVIDENCE_DIRECTORIES = new Set([
  "blob-report",
  "html-report",
  "playwright-output",
]);
const PUBLIC_VISUAL_DIRECTORY = "public-visuals";
const PUBLIC_SCREENSHOT_NAME =
  /^(?:final-state|plan-[a-z0-9-]+|question-[a-z0-9-]+)\.png$/;
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const MAX_PRIVATE_PNG_BYTES = 32 * 1024 * 1024;
const MAX_PRIVATE_PNG_PIXELS = 64 * 1024 * 1024;
const MAX_PRIVATE_PNG_EDGE = 32 * 1024;
const MAX_PUBLIC_PREVIEW_EDGE = 96;
const MAX_PUBLIC_PREVIEW_BYTES = 256 * 1024;
const PRIVATE_PNG_CHUNKS = new Set([
  "IHDR",
  "IDAT",
  "IEND",
  "PLTE",
  "tRNS",
  "gAMA",
  "cHRM",
  "sRGB",
  "pHYs",
]);
const PUBLIC_PNG_CHUNKS = new Set(["IHDR", "IDAT", "IEND", "PLTE"]);

interface PublishedResult {
  executionId?: unknown;
  attempt?: unknown;
  status?: unknown;
  evidenceValid?: unknown;
  screenshots?: unknown;
  [key: string]: unknown;
}

interface PublishedCampaign {
  results?: unknown;
  [key: string]: unknown;
}

export type PublicPreviewTransformer = (
  source: string,
  destination: string,
) => Promise<void>;

function publicVisualPath(evidencePath: string) {
  const segments = evidencePath.split("/");
  return (
    segments.length === 2 &&
    segments[0] === PUBLIC_VISUAL_DIRECTORY &&
    PUBLIC_SCREENSHOT_NAME.test(segments[1] ?? "")
  );
}

export function isPublicHistoryEvidencePath(relative: string) {
  const match = relative.match(
    /^evidence\/[A-Za-z0-9._-]+\/attempt-[1-9][0-9]*\/(.+)$/,
  );
  if (!match) return false;
  const evidencePath = match[1]!;
  const segments = evidencePath.split("/");
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        PRIVATE_EVIDENCE_DIRECTORIES.has(segment),
    )
  ) {
    return false;
  }
  if (publicVisualPath(evidencePath)) return true;
  return PUBLIC_EVIDENCE_EXTENSIONS.has(
    path.posix.extname(evidencePath).toLowerCase(),
  );
}

async function pruneEvidenceDirectory(root: string, current: string) {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) {
      await pruneEvidenceDirectory(root, absolute);
      if ((await readdir(absolute)).length === 0) {
        await rm(absolute, { recursive: true });
      }
      continue;
    }
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    if (!entry.isFile() || !isPublicHistoryEvidencePath(relative)) {
      await rm(absolute, { force: true });
    } else if (path.posix.extname(relative).toLowerCase() === ".png") {
      // Only derived public previews can pass the PNG path allowlist. Validate
      // the bounded inert container again when the AWS publisher prunes its
      // downloaded bundle.
      await validatePublicPreview(absolute);
    }
  }
}

export async function prunePrivateHistoryEvidence(root: string) {
  const evidenceRoot = path.join(root, "evidence");
  const metadata = await lstat(evidenceRoot).catch(() => null);
  if (!metadata) return;
  if (!metadata.isDirectory()) {
    throw new Error("Historical evidence root must be a directory");
  }
  await pruneEvidenceDirectory(root, evidenceRoot);
}

function crc32(buffer: Buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function inspectPng(
  value: Buffer,
  options: {
    label: string;
    maxBytes: number;
    maxEdge?: number;
    maxPixels?: number;
    chunks: ReadonlySet<string>;
  },
) {
  if (value.length > options.maxBytes) {
    throw new Error(`${options.label} exceeds the PNG byte limit`);
  }
  if (
    value.length < PNG_SIGNATURE.length ||
    !value.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
  ) {
    throw new Error(`${options.label} is not a PNG`);
  }
  let offset = PNG_SIGNATURE.length;
  let width = 0;
  let height = 0;
  let sawHeader = false;
  let sawData = false;
  let sawEnd = false;
  while (offset < value.length) {
    if (offset + 12 > value.length) {
      throw new Error(`${options.label} has a truncated PNG chunk`);
    }
    const length = value.readUInt32BE(offset);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + 4;
    if (chunkEnd > value.length) {
      throw new Error(`${options.label} has an invalid PNG chunk length`);
    }
    const type = value.toString("ascii", offset + 4, offset + 8);
    if (!options.chunks.has(type)) {
      throw new Error(`${options.label} contains forbidden PNG chunk ${type}`);
    }
    const expectedCrc = value.readUInt32BE(dataEnd);
    const actualCrc = crc32(value.subarray(offset + 4, dataEnd));
    if (actualCrc !== expectedCrc) {
      throw new Error(`${options.label} contains a corrupt PNG chunk`);
    }
    if (type === "IHDR") {
      if (sawHeader || offset !== PNG_SIGNATURE.length || length !== 13) {
        throw new Error(`${options.label} has an invalid PNG header`);
      }
      sawHeader = true;
      width = value.readUInt32BE(dataStart);
      height = value.readUInt32BE(dataStart + 4);
      const bitDepth = value[dataStart + 8];
      const colorType = value[dataStart + 9];
      const compression = value[dataStart + 10];
      const filter = value[dataStart + 11];
      const interlace = value[dataStart + 12];
      if (
        width < 1 ||
        height < 1 ||
        bitDepth !== 8 ||
        ![2, 3, 6].includes(colorType ?? -1) ||
        compression !== 0 ||
        filter !== 0 ||
        interlace !== 0
      ) {
        throw new Error(`${options.label} uses an unsupported PNG encoding`);
      }
      if (
        options.maxEdge &&
        (width > options.maxEdge || height > options.maxEdge)
      ) {
        throw new Error(`${options.label} exceeds the PNG dimensions`);
      }
      if (options.maxPixels && width * height > options.maxPixels) {
        throw new Error(`${options.label} exceeds the PNG pixel limit`);
      }
    } else if (!sawHeader) {
      throw new Error(`${options.label} has data before its PNG header`);
    } else if (type === "IDAT") {
      sawData = true;
    } else if (type === "IEND") {
      if (!sawData || length !== 0 || chunkEnd !== value.length) {
        throw new Error(`${options.label} has an invalid PNG end marker`);
      }
      sawEnd = true;
    }
    offset = chunkEnd;
  }
  if (!sawHeader || !sawData || !sawEnd) {
    throw new Error(`${options.label} is an incomplete PNG`);
  }
}

async function validatePrivateScreenshot(file: string) {
  const metadata = await lstat(file);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("Public preview source must be a regular file");
  }
  inspectPng(await readFile(file), {
    label: "Public preview source",
    maxBytes: MAX_PRIVATE_PNG_BYTES,
    maxEdge: MAX_PRIVATE_PNG_EDGE,
    maxPixels: MAX_PRIVATE_PNG_PIXELS,
    chunks: PRIVATE_PNG_CHUNKS,
  });
}

async function validatePublicPreview(file: string) {
  const metadata = await lstat(file);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("Public preview output must be a regular file");
  }
  inspectPng(await readFile(file), {
    label: "Public preview output",
    maxBytes: MAX_PUBLIC_PREVIEW_BYTES,
    maxEdge: MAX_PUBLIC_PREVIEW_EDGE,
    chunks: PUBLIC_PNG_CHUNKS,
  });
}

async function assertPreviewHasNoReadableText(file: string) {
  const { stdout } = await execFileAsync(
    process.env.RUNNER_E2E_TESSERACT_BINARY ?? "tesseract",
    [file, "stdout", "--psm", "11", "-l", "eng"],
    {
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, OMP_THREAD_LIMIT: "1" },
    },
  );
  // The report job no longer has provider secrets, so it cannot compare OCR
  // output with exact credential values. Reject every readable letter or digit
  // instead. Do not include OCR output in the error because it is untrusted.
  if (/[\p{L}\p{N}]/u.test(stdout)) {
    throw new Error("Public layout preview still contains OCR-readable text");
  }
}

export async function createPublicLayoutPreview(
  source: string,
  destination: string,
) {
  await validatePrivateScreenshot(source);
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = await mkdtemp(
    path.join(path.dirname(destination), ".preview-"),
  );
  const output = path.join(temporary, "preview.png");
  try {
    await execFileAsync(
      process.env.RUNNER_E2E_IMAGE_MAGICK_BINARY ?? "convert",
      [
        "-limit",
        "memory",
        "128MiB",
        "-limit",
        "map",
        "256MiB",
        "-limit",
        "disk",
        "256MiB",
        "-limit",
        "thread",
        "1",
        "-limit",
        "time",
        "30",
        source,
        "-background",
        "#f3f4f6",
        "-alpha",
        "remove",
        "-alpha",
        "off",
        "-resize",
        `${MAX_PUBLIC_PREVIEW_EDGE}x${MAX_PUBLIC_PREVIEW_EDGE}>`,
        "-blur",
        "0x3.5",
        "-colors",
        "16",
        "-strip",
        "-define",
        "png:exclude-chunks=all",
        `PNG8:${output}`,
      ],
      { timeout: 45_000, maxBuffer: 1024 * 1024 },
    );
    await validatePublicPreview(output);
    await assertPreviewHasNoReadableText(output);
    await copyFile(output, destination, fsConstants.COPYFILE_EXCL);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function assertTreeContainsNoLinks(root: string, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    const metadata = await lstat(absolute);
    if (metadata.isSymbolicLink()) {
      throw new Error("Public history source must not contain symbolic links");
    }
    if (metadata.isDirectory()) await assertTreeContainsNoLinks(root, absolute);
  }
}

async function removeExistingPublicVisuals(current: string) {
  const entries = await readdir(current, { withFileTypes: true }).catch(
    () => [],
  );
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    if (!entry.isDirectory()) continue;
    if (entry.name === PUBLIC_VISUAL_DIRECTORY) {
      await rm(absolute, { recursive: true, force: true });
      continue;
    }
    await removeExistingPublicVisuals(absolute);
  }
}

function safePassedScreenshot(input: unknown) {
  if (!input || typeof input !== "object") {
    throw new Error("Passing result has invalid screenshot metadata");
  }
  const screenshot = input as Record<string, unknown>;
  if (
    typeof screenshot.id !== "string" ||
    typeof screenshot.label !== "string" ||
    typeof screenshot.file !== "string" ||
    !PUBLIC_SCREENSHOT_NAME.test(screenshot.file)
  ) {
    throw new Error("Passing result has unsafe screenshot metadata");
  }
  return {
    id: screenshot.id,
    label: `${screenshot.label} (redacted layout preview)`,
    file: `${PUBLIC_VISUAL_DIRECTORY}/${screenshot.file}`,
    privateFile: screenshot.file,
  };
}

export async function preparePublicHistoryBundle(input: {
  source: string;
  destination: string;
  transform?: PublicPreviewTransformer;
}) {
  const source = path.resolve(input.source);
  const destination = path.resolve(input.destination);
  if (
    source === destination ||
    source.startsWith(`${destination}${path.sep}`) ||
    destination.startsWith(`${source}${path.sep}`)
  ) {
    throw new Error("Public history source and destination must not overlap");
  }
  const sourceMetadata = await lstat(source);
  if (!sourceMetadata.isDirectory() || sourceMetadata.isSymbolicLink()) {
    throw new Error("Public history source must be a directory");
  }
  await assertTreeContainsNoLinks(source);
  await rm(destination, { recursive: true, force: true });
  await cp(source, destination, { recursive: true, force: false });

  const normalizedFile = path.join(destination, "normalized-results.json");
  const campaign = JSON.parse(
    await readFile(normalizedFile, "utf8"),
  ) as PublishedCampaign;
  if (!Array.isArray(campaign.results)) {
    throw new Error("Public history source has invalid campaign results");
  }
  await removeExistingPublicVisuals(path.join(destination, "evidence"));

  const transform = input.transform ?? createPublicLayoutPreview;
  let previewCount = 0;
  const results: PublishedResult[] = [];
  for (const untrustedResult of campaign.results) {
    if (!untrustedResult || typeof untrustedResult !== "object") {
      throw new Error("Public history source has an invalid result");
    }
    const result = untrustedResult as PublishedResult;
    if (result.status !== "passed" || result.evidenceValid === false) {
      results.push(result);
      continue;
    }
    if (
      typeof result.executionId !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,299}$/.test(result.executionId) ||
      !Number.isSafeInteger(result.attempt) ||
      Number(result.attempt) < 1 ||
      !Array.isArray(result.screenshots) ||
      result.screenshots.length === 0
    ) {
      throw new Error("Passing result lacks safe screenshot provenance");
    }
    const base = path.join(
      destination,
      "evidence",
      result.executionId,
      `attempt-${String(result.attempt)}`,
    );
    const publicVisuals = path.join(base, PUBLIC_VISUAL_DIRECTORY);
    await rm(publicVisuals, { recursive: true, force: true });
    await mkdir(publicVisuals, { recursive: true });
    const screenshots = [];
    const seen = new Set<string>();
    for (const entry of result.screenshots) {
      const screenshot = safePassedScreenshot(entry);
      if (seen.has(screenshot.privateFile)) {
        throw new Error("Passing result has duplicate screenshot metadata");
      }
      seen.add(screenshot.privateFile);
      const sourceScreenshot = path.join(base, screenshot.privateFile);
      const publicScreenshot = path.join(publicVisuals, screenshot.privateFile);
      await validatePrivateScreenshot(sourceScreenshot);
      await transform(sourceScreenshot, publicScreenshot);
      await validatePublicPreview(publicScreenshot);
      const { privateFile: _, ...publishedScreenshot } = screenshot;
      screenshots.push(publishedScreenshot);
      previewCount += 1;
    }
    results.push({ ...result, screenshots });
  }
  await writeFile(
    normalizedFile,
    `${JSON.stringify({ ...campaign, results }, null, 2)}\n`,
    "utf8",
  );
  await prunePrivateHistoryEvidence(destination);
  await regenerateRunnerDashboard({ bundle: destination, historyFile: null });
  console.log(
    `Prepared ${previewCount} public low-resolution layout preview(s); full-resolution visual evidence remains private`,
  );
  return { previewCount };
}

async function main() {
  const [source, destination] = process.argv
    .slice(2)
    .filter((argument) => argument !== "--");
  if (!source || !destination) {
    throw new Error(
      "Usage: history-public-bundle.ts <private-report-directory> <public-report-directory>",
    );
  }
  await preparePublicHistoryBundle({ source, destination });
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(import.meta.filename)
) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
