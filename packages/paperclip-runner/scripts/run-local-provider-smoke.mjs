#!/usr/bin/env node

import { access, mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { withIsolatedProfileCredentials } from "./local-provider-smoke-environment.mjs";

const PROFILE_IDS = [
  "runner-acpx-claude",
  "runner-acpx-codex",
  "runner-codex",
  "runner-opencode",
];

function parseProfiles(args) {
  const selected = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--profile" || !args[index + 1]) {
      throw new Error(
        `Usage: pnpm smoke:local-provider -- --profile <${PROFILE_IDS.join("|")}|all>`,
      );
    }
    selected.push(args[++index]);
  }
  if (selected.length === 0) return ["runner-acpx-claude"];
  const expanded = selected.flatMap((profile) =>
    profile === "all" ? PROFILE_IDS : [profile],
  );
  for (const profile of expanded) {
    if (!PROFILE_IDS.includes(profile)) {
      throw new Error(`Unsupported local provider smoke profile: ${profile}`);
    }
  }
  return [...new Set(expanded)];
}

function liveCandidate(id, candidateSlots) {
  const candidates = candidateSlots.flatMap((slot) => slot.candidates);
  if (id === "runner-acpx-claude") {
    return candidates.find(
      (candidate) => candidate.id === "acpx-claude-sonnet",
    );
  }
  if (id === "runner-acpx-codex") {
    return candidates.find((candidate) => candidate.id === "acpx-codex-sol");
  }
  if (id === "runner-codex") {
    const source = candidates.find(
      (candidate) => candidate.id === "codex-luna",
    );
    return (
      source && {
        ...source,
        id: "runner-codex-sol",
        model: "gpt-5.6-sol",
      }
    );
  }
  const source = candidates.find(
    (candidate) => candidate.id === "opencode-kimi",
  );
  return (
    source && {
      ...source,
      id: "runner-opencode-deepseek",
      model: "openrouter/deepseek/deepseek-v4-flash-0731",
    }
  );
}

function failedChecks(observation) {
  const smokeChecks = new Set([
    "terminal-authority",
    "first-visible-progress",
    "substantive-response",
    "expected-assistant-text",
    "no-empty-comment",
    "terminal-presentation",
  ]);
  return [...observation.lifecycle.checks, ...observation.presentation.checks]
    .filter((check) => smokeChecks.has(check.id) && !check.passed)
    .map((check) => check.id);
}

function safeErrorMessage(error, credentialValues) {
  let message = error instanceof Error ? error.message : String(error);
  for (const credential of credentialValues) {
    if (credential.length > 0)
      message = message.split(credential).join("[REDACTED]");
  }
  return message
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]")
    .slice(0, 1_000);
}

async function filesUnder(directory, include, skipDirectory = () => false) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!skipDirectory(path)) {
        files.push(...(await filesUnder(path, include, skipDirectory)));
      }
    } else if (entry.isFile() && include(path)) {
      files.push(path);
    }
  }
  return files;
}

async function assertArtifactsFresh(label, sources, artifacts) {
  const sourceTimes = await Promise.all(
    sources.map(async (source) => (await stat(source)).mtimeMs),
  );
  const artifactTimes = await Promise.all(
    artifacts.map(async (artifact) => (await stat(artifact)).mtimeMs),
  );
  if (Math.max(...sourceTimes) > Math.min(...artifactTimes)) {
    throw new Error(
      `${label} smoke artifacts are older than their source. Rebuild the targeted artifacts before running the smoke.`,
    );
  }
}

const profiles = parseProfiles(process.argv.slice(2));
const packageRoot = resolve(import.meta.dirname, "..");
const runnerd = resolve(
  packageRoot,
  "runner",
  "target",
  "debug",
  process.platform === "win32" ? "paperclip-runnerd.exe" : "paperclip-runnerd",
);
const requiredArtifacts = [
  runnerd,
  resolve(packageRoot, "dist", "eval", "index.js"),
  ...(profiles.some((profile) => profile.startsWith("runner-acpx-"))
    ? [resolve(packageRoot, "dist", "cli", "acpx-runtime-sidecar.cjs")]
    : []),
  ...(profiles.includes("runner-opencode")
    ? [resolve(packageRoot, "dist", "cli", "opencode-app-server-proxy.cjs")]
    : []),
];
await Promise.all(requiredArtifacts.map((artifact) => access(artifact))).catch(
  () => {
    throw new Error(
      "Local provider smoke artifacts are missing. Run build:typescript and build:runner-binaries once.",
    );
  },
);

const typescriptSources = await filesUnder(
  resolve(packageRoot, "src"),
  (path) => path.endsWith(".ts") && !path.endsWith(".test.ts"),
  (path) =>
    /\/(?:browser|devtools|issue-thread|react|scenarios|standalone)$/u.test(
      path,
    ),
);
await assertArtifactsFresh(
  "TypeScript",
  [
    resolve(packageRoot, "package.json"),
    resolve(packageRoot, "tsconfig.json"),
    ...typescriptSources,
  ],
  requiredArtifacts.filter((artifact) => artifact !== runnerd),
);
const rustSources = await filesUnder(
  resolve(packageRoot, "runner"),
  (path) =>
    path.endsWith(".rs") ||
    path.endsWith("Cargo.toml") ||
    path.endsWith("Cargo.lock"),
  (path) => /\/(?:target|tests|benches|examples)$/u.test(path),
);
await assertArtifactsFresh("runnerd", rustSources, [runnerd]);

const smokeRoot = await mkdtemp(
  join(tmpdir(), "paperclip-local-provider-smoke-"),
);
if (!basename(smokeRoot).startsWith("paperclip-local-provider-smoke-")) {
  throw new Error("Refusing an unrecognized local provider smoke root");
}
await Promise.all(
  ["tmp", "home", "paperclip-home", "codex-home", "claude-home"].map(
    (directory) => mkdir(join(smokeRoot, directory), { recursive: true }),
  ),
);

const ambientEnvironment = { ...process.env };
for (const name of Object.keys(process.env)) delete process.env[name];
for (const name of [
  "PATH",
  "SystemRoot",
  "ComSpec",
  "PATHEXT",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
]) {
  if (ambientEnvironment[name] !== undefined) {
    process.env[name] = ambientEnvironment[name];
  }
}
Object.assign(process.env, {
  TMPDIR: join(smokeRoot, "tmp"),
  HOME: join(smokeRoot, "home"),
  PAPERCLIP_HOME: join(smokeRoot, "paperclip-home"),
  CODEX_HOME: join(smokeRoot, "codex-home"),
  CLAUDE_CONFIG_DIR: join(smokeRoot, "claude-home"),
  NO_BROWSER: "1",
  PAPERCLIP_OPEN_ON_LISTEN: "false",
});

let cleanupPromise;
const cleanup = () => {
  cleanupPromise ??= rm(smokeRoot, { recursive: true, force: true });
  return cleanupPromise;
};
const exitAfterCleanup = (status) => {
  void cleanup().finally(() => process.exit(status));
};
process.once("SIGINT", () => exitAfterCleanup(130));
process.once("SIGTERM", () => exitAfterCleanup(143));

let failed = false;
try {
  // Import only after the disposable homes are authoritative so no provider
  // module can snapshot the developer's normal Paperclip or provider state.
  const {
    RUNNER_LIVE_CANDIDATE_SLOTS,
    executeLiveRunnerWorkflow,
    runnerWorkflowCase,
  } = await import("../dist/eval/index.js");
  const candidates = new Map(
    profiles.map((profile) => [
      profile,
      liveCandidate(profile, RUNNER_LIVE_CANDIDATE_SLOTS),
    ]),
  );
  const credentialsByProfile = new Map();
  for (const [profile, candidate] of candidates) {
    if (!candidate) throw new Error(`Missing live candidate for ${profile}`);
    const missingCredentials = [];
    const profileCredentials = {};
    for (const name of candidate.qualification.requiredEnvironment) {
      const value = ambientEnvironment[name]?.trim();
      if (value) profileCredentials[name] = value;
      else missingCredentials.push(name);
    }
    if (missingCredentials.length > 0) {
      throw new Error(
        `${profile} requires ${missingCredentials.join(", ")} in the smoke process environment`,
      );
    }
    credentialsByProfile.set(profile, profileCredentials);
  }
  const providerCredentialNames = new Set(
    [...credentialsByProfile.values()].flatMap((credentials) =>
      Object.keys(credentials),
    ),
  );
  const credentialValues = new Set(
    [...credentialsByProfile.values()].flatMap((credentials) =>
      Object.values(credentials),
    ),
  );
  const evalCase = runnerWorkflowCase("completion-robustness");
  for (const profile of profiles) {
    const candidate = candidates.get(profile);
    const workspace = join(smokeRoot, `workspace-${profile}`);
    await mkdir(workspace, { recursive: true });
    const entry = {
      // Avoid a three-segment dotted identity: durable redaction correctly
      // treats that shape as a possible JWT and refuses to rewrite IDs.
      executionId: `local-smoke-${profile}-${String(Date.now())}`,
      caseId: evalCase.id,
      candidateId: candidate.id,
      slotId: candidate.slotId,
      repetition: 1,
      providerTrace: "raw",
      budget: candidate.budget,
    };
    try {
      const observation = await withIsolatedProfileCredentials({
        environment: process.env,
        providerCredentialNames,
        profileCredentials: credentialsByProfile.get(profile),
        run: () =>
          executeLiveRunnerWorkflow({
            entry,
            candidate,
            evalCase,
            workingDirectory: workspace,
            // This smoke proves the provider launch/message/semantic-terminal path.
            // Usage conformance remains covered by the dedicated eval campaign.
            allowMissingUsage: true,
            expectedAssistantText: "PAPERCLIP_LOCAL_PROVIDER_SMOKE_OK",
            promptOverride:
              "Reply with exactly PAPERCLIP_LOCAL_PROVIDER_SMOKE_OK and no other text. Do not call tools.",
            runnerBinary: runnerd,
          }),
      });
      const failures = failedChecks(observation);
      const passed = failures.length === 0;
      failed ||= !passed;
      process.stdout.write(
        `${JSON.stringify({
          profile,
          status: passed ? "passed" : "failed",
          classification: passed
            ? "message_completed"
            : observation.classification,
          settlementMs: observation.metrics.settlementMs ?? null,
          totalTokens: observation.metrics.totalTokens ?? null,
          costUsd: observation.metrics.costUsd ?? null,
          failedChecks: failures,
          failureCode: observation.failure?.code ?? null,
        })}\n`,
      );
    } catch (error) {
      failed = true;
      process.stderr.write(
        `${JSON.stringify({
          profile,
          status: "failed",
          infrastructureError: safeErrorMessage(error, credentialValues),
        })}\n`,
      );
    }
  }
} finally {
  await cleanup();
}

if (failed) process.exitCode = 1;
