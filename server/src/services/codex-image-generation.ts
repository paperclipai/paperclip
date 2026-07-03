import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import { unprocessable } from "../errors.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import {
  PAPERCLIP_IMAGE_MODEL,
  type ImageReferenceInput,
} from "./openai-image-generation.js";

type GenerationMode = "prompt_only" | "reference_backed";

export interface GenerateCodexImageInput {
  prompt: string;
  size: string;
  quality: string;
  references: ImageReferenceInput[];
  companyId: string;
  agentId?: string | null;
  runId?: string | null;
  codexHome?: string | null;
  codexCommand?: string | null;
  codexModel?: string | null;
  timeoutSec?: number | null;
  runProcess?: typeof runChildProcess;
}

export interface GenerateCodexImageResult {
  provider: "codex_native";
  model: typeof PAPERCLIP_IMAGE_MODEL;
  endpoint: "codex_exec_image_gen";
  generationMode: GenerationMode;
  actualImageInputsBound: string[];
  outputBytes: Buffer;
  outputContentType: "image/png";
  providerRequestId: string | null;
  codexThreadId: string | null;
  codexOutputPath: string | null;
}

type CodexJsonLine = {
  type?: unknown;
  thread_id?: unknown;
};

const IMAGE_CONTENT_TYPE_EXTENSION: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/webp": ".webp",
};
const DEFAULT_CODEX_IMAGE_REASONING_MODEL = "gpt-5.5";

function nonEmptyString(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function positiveNumber(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveCodexImageHome(env: NodeJS.ProcessEnv = process.env) {
  return path.resolve(nonEmptyString(env.PAPERCLIP_IMAGE_CODEX_HOME) ?? nonEmptyString(env.CODEX_HOME) ?? path.join(os.homedir(), ".codex"));
}

function codexHomeCandidates(input: {
  companyId?: string | null;
  agentId?: string | null;
  env?: NodeJS.ProcessEnv;
}) {
  const env = input.env ?? process.env;
  const candidates: string[] = [];
  const override = nonEmptyString(env.PAPERCLIP_IMAGE_CODEX_HOME);
  if (override) return [path.resolve(override)];

  const instanceRoot = resolvePaperclipInstanceRoot();
  const agentId = nonEmptyString(input.agentId ?? null);
  const companyId = nonEmptyString(input.companyId ?? null);
  if (agentId) candidates.push(path.resolve(instanceRoot, "agent-homes", agentId, ".codex"));
  if (companyId) candidates.push(path.resolve(instanceRoot, "companies", companyId, "codex-home"));
  const configuredCodexHome = nonEmptyString(env.CODEX_HOME);
  if (configuredCodexHome) candidates.push(path.resolve(configuredCodexHome));
  candidates.push(path.join(os.homedir(), ".codex"));
  return Array.from(new Set(candidates));
}

async function resolveCodexImageHomeForInput(input: {
  companyId?: string | null;
  agentId?: string | null;
  codexHome?: string | null;
}) {
  const explicit = nonEmptyString(input.codexHome ?? null);
  if (explicit) return path.resolve(explicit);

  const candidates = codexHomeCandidates(input);
  for (const candidate of candidates) {
    const authPath = path.join(candidate, "auth.json");
    if (await fs.access(authPath).then(() => true).catch(() => false)) {
      return candidate;
    }
  }
  return candidates[0] ?? resolveCodexImageHome();
}

async function prepareIsolatedCodexHome(authHome: string, runtimeDir: string) {
  const home = path.join(runtimeDir, "codex-home");
  await fs.mkdir(home, { recursive: true });
  const authPath = path.join(authHome, "auth.json");
  if (await fs.access(authPath).then(() => true).catch(() => false)) {
    await fs.symlink(authPath, path.join(home, "auth.json"));
  }
  return home;
}

async function createRuntimeDir() {
  const base = path.resolve(resolvePaperclipInstanceRoot(), "data", "codex-image-runtime");
  await fs.mkdir(base, { recursive: true });
  return fs.mkdtemp(path.join(base, "run-"));
}

function safeAttachmentStem(reference: ImageReferenceInput, index: number) {
  const base = (reference.filename ?? reference.attachmentId)
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return base || `reference-${index + 1}`;
}

function extensionForContentType(contentType: string) {
  return IMAGE_CONTENT_TYPE_EXTENSION[contentType.toLowerCase()] ?? ".png";
}

async function writeReferenceFiles(references: ImageReferenceInput[], dir: string) {
  const paths: string[] = [];
  for (const [index, reference] of references.entries()) {
    const filePath = path.join(dir, `${index + 1}-${safeAttachmentStem(reference, index)}${extensionForContentType(reference.contentType)}`);
    await fs.writeFile(filePath, reference.bytes, { mode: 0o600 });
    paths.push(filePath);
  }
  return paths;
}

function buildCodexImagePrompt(input: GenerateCodexImageInput) {
  const referenceLines = input.references.map((reference, index) =>
    `- Reference ${index + 1}: attachmentId=${reference.attachmentId}, filename=${reference.filename ?? "unknown"}, contentType=${reference.contentType}, byteSize=${reference.bytes.length}`,
  );
  return [
    "You are running inside Paperclip's Codex image-generation bridge.",
    "Use the native image generation/editing tool available in this Codex runtime. Do not use shell commands, code, local drawing scripts, browser screenshots, external APIs, or prompt-only recreation.",
    "Generate exactly one final PNG image.",
    `Requested model: ${PAPERCLIP_IMAGE_MODEL}.`,
    `Requested size: ${input.size}.`,
    `Requested quality: ${input.quality}.`,
    input.references.length > 0
      ? [
          "The images attached to this Codex prompt with --image are real visual reference inputs.",
          "Use those attached image inputs as visual references for the generated image; do not merely describe them in text.",
          "Reference attachments:",
          ...referenceLines,
        ].join("\n")
      : "No visual reference image was requested; this is a text-to-image generation.",
    "User prompt:",
    input.prompt,
    "After the native image tool finishes, return JSON with {\"imageGenerated\":true}.",
  ].join("\n\n");
}

function parseThreadId(stdout: string) {
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as CodexJsonLine;
      if (parsed.type === "thread.started" && typeof parsed.thread_id === "string" && parsed.thread_id.length > 0) {
        return parsed.thread_id;
      }
    } catch {
      // Ignore non-JSON status lines from older Codex versions.
    }
  }
  return null;
}

async function listGeneratedImages(codexHome: string, threadId: string | null) {
  if (!threadId) return [];
  const dir = path.join(codexHome, "generated_images", threadId);
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const files = entries
    .filter((entry) => entry.isFile() && /\.(png|jpe?g|webp)$/i.test(entry.name))
    .map((entry) => path.join(dir, entry.name));
  const stats = await Promise.all(
    files.map(async (filePath) => ({
      filePath,
      stat: await fs.stat(filePath).catch(() => null),
    })),
  );
  return stats
    .filter((entry): entry is { filePath: string; stat: NonNullable<typeof entry.stat> } => Boolean(entry.stat))
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
    .map((entry) => entry.filePath);
}

export async function generateCodexIssueImage(input: GenerateCodexImageInput): Promise<GenerateCodexImageResult> {
  const generationMode: GenerationMode = input.references.length > 0 ? "reference_backed" : "prompt_only";
  const authCodexHome = await resolveCodexImageHomeForInput(input);
  const codexCommand = input.codexCommand?.trim() || process.env.PAPERCLIP_IMAGE_CODEX_COMMAND?.trim() || "codex";
  const codexModel = input.codexModel?.trim() || process.env.PAPERCLIP_IMAGE_CODEX_MODEL?.trim() || DEFAULT_CODEX_IMAGE_REASONING_MODEL;
  const timeoutSec = Math.max(30, positiveNumber(input.timeoutSec ?? process.env.PAPERCLIP_IMAGE_CODEX_TIMEOUT_SEC, 300));
  const runProcess = input.runProcess ?? runChildProcess;
  const tempDir = await createRuntimeDir();
  const runtimeCodexHome = await prepareIsolatedCodexHome(authCodexHome, tempDir);
  const outputSchemaPath = path.join(tempDir, "image-output.schema.json");

  try {
    const referenceFilePaths = await writeReferenceFiles(input.references, tempDir);
    await fs.writeFile(
      outputSchemaPath,
      JSON.stringify({
        type: "object",
        properties: {
          imageGenerated: { type: "boolean" },
        },
        required: ["imageGenerated"],
        additionalProperties: false,
      }),
      { mode: 0o600 },
    );

    const args = [
      "exec",
      "--json",
      "--ignore-user-config",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "--output-schema",
      outputSchemaPath,
    ];
    if (codexModel) args.push("--model", codexModel);
    for (const referenceFilePath of referenceFilePaths) {
      args.push("--image", referenceFilePath);
    }
    args.push("-");

    const proc = await runProcess(
      `image-generation-${input.runId ?? input.companyId}-${Date.now()}`,
      codexCommand,
      args,
      {
        cwd: tempDir,
        env: {
          CODEX_HOME: runtimeCodexHome,
          OPENAI_API_KEY: "",
        },
        timeoutSec,
        graceSec: 10,
        stdin: buildCodexImagePrompt(input),
        onLog: async () => undefined,
      },
    );

    if (proc.exitCode !== 0) {
      throw unprocessable(`Codex image generation failed with exit code ${proc.exitCode}: ${proc.stderr || proc.stdout || "no output"}`);
    }

    const threadId = parseThreadId(proc.stdout);
    const [outputPath] = await listGeneratedImages(runtimeCodexHome, threadId);
    if (!outputPath) {
      throw unprocessable(
        threadId
          ? `Codex image generation completed but no generated image was found for thread ${threadId}`
          : "Codex image generation completed but did not report a thread id or generated image",
      );
    }

    const outputBytes = await fs.readFile(outputPath);
    if (outputBytes.length <= 0) {
      throw unprocessable("Codex image generation produced an empty image");
    }

    return {
      provider: "codex_native",
      model: PAPERCLIP_IMAGE_MODEL,
      endpoint: "codex_exec_image_gen",
      generationMode,
      actualImageInputsBound: input.references.map((reference) => reference.attachmentId),
      outputBytes,
      outputContentType: "image/png",
      providerRequestId: threadId,
      codexThreadId: threadId,
      codexOutputPath: null,
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
