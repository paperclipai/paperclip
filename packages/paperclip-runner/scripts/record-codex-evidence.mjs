#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertCodexTraceReadyForOutputs,
  createCodexDeniedHostPaths,
  findReadableCodexCredentialFiles,
  readRequiredCodexOutput,
} from "./lib/codex-evidence.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function recordCodexEvidence() {
  const scratchRoot =
    process.env.PAPERCLIP_RUN_SCRATCH_DIR ??
    process.env.PAPERCLIP_SCRATCH_DIR ??
    tmpdir();
  await mkdir(scratchRoot, { recursive: true });
  const workspace = await mkdtemp(join(scratchRoot, "paperclip-runner-codex-"));
  const hostileHostDirectory = await mkdtemp(join(scratchRoot, "paperclip-runner-codex-host-"));
  const unrelatedSecretPath = join(hostileHostDirectory, "unrelated-secret.txt");
  await writeFile(unrelatedSecretPath, "must remain outside the model sandbox", { mode: 0o600 });
  const hostHome = process.env.HOME;
  if (!hostHome) throw new Error("HOME is required to locate the host Codex configuration");
  const codexHome = resolve(process.env.CODEX_HOME ?? join(hostHome, ".codex"));
  const codexCredentialFiles = await findReadableCodexCredentialFiles(codexHome);
  if (codexCredentialFiles.length === 0) {
    throw new Error(
      "No readable host Codex auth.json or config.toml file was available for the isolation probe",
    );
  }
  const deniedHostPaths = createCodexDeniedHostPaths({
    hostHome,
    codexCredentialFiles,
    unrelatedSecretPath,
  });
  const rawTracePath = join(workspace, "trace.raw.json");
  const evidencePath = join(
    packageRoot,
    "knowledge/evidence/codex-trace.json",
  );

  try {
    const run = spawnSync(
      process.execPath,
      [
        join(packageRoot, "dist/cli/codex.js"),
        "--working-directory",
        workspace,
        "--output",
        rawTracePath,
        ...deniedHostPaths.flatMap((path) => ["--deny-read-write-path", path]),
      ],
      {
        cwd: packageRoot,
        env: { ...process.env, PAPERCLIP_WORKSPACE_CWD: workspace },
        stdio: "inherit",
      },
    );
    if (run.error) {
      throw new Error(`Codex tracer could not start: ${run.error.message}`);
    }

    let trace;
    try {
      trace = JSON.parse(await readFile(rawTracePath, "utf8"));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Codex tracer did not produce a readable trace (status ${run.status ?? "unknown"}): ${detail}`,
      );
    }
    assertCodexTraceReadyForOutputs(trace);
    if (run.status !== 0) {
      throw new Error(
        `Codex tracer exited with status ${run.status ?? "unknown"} after reporting an accepted \`done\` result`,
      );
    }
    const hello = await readRequiredCodexOutput(join(workspace, "hello.txt"), "hello.txt");
    if (hello !== "hello from Codex runner") {
      throw new Error("Codex safe task produced unexpected hello.txt content");
    }
    const isolationProof = await readRequiredCodexOutput(
      join(workspace, "isolation-ok.txt"),
      "isolation-ok.txt",
    );
    if (isolationProof !== "isolation enforced") {
      throw new Error("Codex isolation probe did not produce the expected proof file");
    }
    const commandObserved = trace.events?.some((event) =>
      event.eventType === "item.started" &&
      event.payload?.kind === "commandExecution" &&
      deniedHostPaths.every((path) => JSON.stringify(event.payload).includes(path))
    );
    const proofOutputObserved = trace.events?.some((event) =>
      (event.eventType === "item.delta" || event.eventType === "item.completed") &&
      event.payload?.kind === "commandExecution" &&
      (
        String(event.payload?.text).includes("isolation enforced") ||
        String(event.payload?.item?.aggregatedOutput).includes("isolation enforced")
      )
    );
    if (!commandObserved || !proofOutputObserved) {
      throw new Error("Codex trace did not retain the successful hostile-path isolation command");
    }

    const replacements = [
      [workspace, "$CODEX_WORKSPACE"],
      ...codexCredentialFiles.map((path) => [
        path,
        path.endsWith("auth.json") ? "$HOST_CODEX_AUTH_PATH" : "$HOST_CODEX_CONFIG_PATH",
      ]),
      [codexHome, "$HOST_CODEX_HOME"],
      [unrelatedSecretPath, "$HOST_UNRELATED_SECRET"],
      [hostileHostDirectory, "$HOST_SECRET_DIRECTORY"],
      [resolve(hostHome), "$HOST_HOME"],
    ];
    const writableRoots = trace.context?.sandbox?.writableRoots;
    if (Array.isArray(writableRoots)) {
      writableRoots.forEach((root, index) => {
        if (typeof root === "string" && root.length > 0) {
          replacements.push([root, `$CODEX_WRITABLE_ROOT_${index + 1}`]);
        }
      });
    }
    const normalized = normalizeStrings(trace, replacements);
    await writeFile(evidencePath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
    process.stdout.write(`Recorded ${evidencePath}\n`);
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(hostileHostDirectory, { recursive: true, force: true });
  }
}

try {
  await recordCodexEvidence();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Codex evidence recording failed: ${message}\n`);
  process.exitCode = 1;
}

function normalizeStrings(value, replacements) {
  if (typeof value === "string") {
    return replacements.reduce(
      (current, [from, to]) => current.replaceAll(from, to),
      value,
    );
  }
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeStrings(entry, replacements));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        normalizeStrings(entry, replacements),
      ]),
    );
  }
  return value;
}
