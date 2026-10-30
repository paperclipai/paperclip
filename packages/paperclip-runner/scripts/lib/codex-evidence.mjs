import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export function codexCredentialFileCandidates(codexHome) {
  return [join(codexHome, "auth.json"), join(codexHome, "config.toml")];
}

export async function findReadableCodexCredentialFiles(codexHome) {
  const readable = [];
  for (const candidate of codexCredentialFileCandidates(codexHome)) {
    try {
      await access(candidate, constants.R_OK);
      readable.push(resolve(candidate));
    } catch {
      // A signed-in Codex installation may use either file. Probe both.
    }
  }
  return readable;
}

export function createCodexDeniedHostPaths({
  hostHome,
  codexCredentialFiles,
  unrelatedSecretPath,
}) {
  return [...new Set([
    resolve(hostHome),
    ...codexCredentialFiles.map((path) => resolve(path)),
    resolve(unrelatedSecretPath),
  ])];
}

export function assertCodexTraceReadyForOutputs(trace) {
  const decision = trace?.resultDecision?.status;
  const disposition = trace?.result?.reportedWorkDisposition;
  if (decision !== "accepted" || disposition !== "done") {
    const summary = codexTraceSummary(trace);
    throw new Error(
      "Codex recorder requires an accepted `done` result before reading workspace outputs; " +
      `received decision=${decision ?? "missing"}, disposition=${disposition ?? "missing"}` +
      `${summary ? ` (${summary})` : ""}. Expected workspace outputs were not read.`,
    );
  }

  const failedAssertions = Object.entries(trace?.assertions ?? {})
    .filter(([, passed]) => passed !== true)
    .map(([name]) => name);
  if (failedAssertions.length > 0) {
    throw new Error(
      `Codex tracer reported failed assertions: ${failedAssertions.join(", ")}`,
    );
  }
}

export async function readRequiredCodexOutput(path, displayName) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      throw new Error(
        `Codex recorder expected ${displayName} after an accepted \`done\` result, but the file was not created.`,
      );
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Codex recorder could not read ${displayName}: ${detail}`);
  }
}

function codexTraceSummary(trace) {
  if (typeof trace?.result?.summary === "string" && trace.result.summary.trim().length > 0) {
    return trace.result.summary.trim();
  }
  const issues = trace?.resultDecision?.issues;
  if (!Array.isArray(issues)) return "";
  return issues
    .map((issue) => issue?.message)
    .filter((message) => typeof message === "string" && message.trim().length > 0)
    .join("; ");
}
