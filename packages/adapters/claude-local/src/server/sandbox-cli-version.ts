import type { AdapterEnvironmentCheck } from "@paperclipai/adapter-utils";
import { maybeRunSandboxInstallCommand, type AdapterSandboxInstallCommandCheck } from "@paperclipai/adapter-utils/execution-target";
import { shellQuote } from "@paperclipai/adapter-utils/ssh";
import path from "node:path";
import { claudeCliVersionAtLeast, readClaudeCommandVersion } from "./cli-capabilities.js";

function installationFailureDetail(check: AdapterSandboxInstallCommandCheck | null): string {
  if (check?.message.includes("timed out")) return "The package installation timed out.";
  const detail = check?.detail ?? "";
  if (/\b(?:EACCES|EPERM)\b/.test(detail)) return "The package installation was denied filesystem access.";
  if (/\b(?:EAI_AGAIN|ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED)\b/.test(detail)) return "The package installation could not reach the registry.";
  if (/\b(?:E404|ETARGET|ENOVERSIONS)\b/.test(detail)) return "The required package version could not be resolved from the registry.";
  if (check?.message.includes("threw before completion")) return "The package installer could not complete execution.";
  const exitCode = check?.message.match(/^Install command exited (\d+):/)?.[1];
  return exitCode ? `The package installer exited with code ${exitCode}.` : "The package installation did not complete successfully.";
}

export async function prepareCompatibleClaudeCommand(
  input: Parameters<typeof readClaudeCommandVersion>[0] & { minimumVersion: string },
): Promise<{ command: string; version: string | null; check?: AdapterEnvironmentCheck }> {
  const detected = await readClaudeCommandVersion(input);
  const original = { command: input.command, version: detected };
  if (
    !detected || claudeCliVersionAtLeast(detected, input.minimumVersion) ||
    input.target?.kind !== "remote" || input.target.transport !== "sandbox" ||
    input.command !== "claude" || !/^\d+\.\d+\.\d+$/.test(input.minimumVersion)
  ) return original;

  const prefix = path.posix.join(input.target.remoteCwd, ".paperclip-runtime", "claude-cli", input.minimumVersion);
  const command = path.posix.join(prefix, "bin", "claude");
  const existing = await readClaudeCommandVersion({ ...input, command });
  if (existing && claudeCliVersionAtLeast(existing, input.minimumVersion)) return { command, version: existing };

  const installation = await maybeRunSandboxInstallCommand({
    runId: input.runId,
    target: input.target,
    adapterKey: "claude",
    installCommand: `npm install --global --prefix ${shellQuote(prefix)} @anthropic-ai/claude-code@${input.minimumVersion}`,
    env: Object.fromEntries(Object.entries(input.env).filter(([key]) => [
      "PATH", "HOME", "TMPDIR", "TEMP", "TMP", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
      "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
      "NPM_CONFIG_REGISTRY", "npm_config_registry",
    ].includes(key))),
    timeoutSec: 120,
  });
  if (installation?.level !== "info") return { ...original, check: {
    code: "claude_runtime_preparation_failed", level: "warn",
    message: "Paperclip could not install a compatible Claude runtime.",
    detail: installationFailureDetail(installation),
  } };
  const version = await readClaudeCommandVersion({ ...input, command });
  if (!version || !claudeCliVersionAtLeast(version, input.minimumVersion)) return { ...original, check: {
    code: "claude_runtime_preparation_failed", level: "warn",
    message: "Paperclip installed the Claude runtime but could not verify a compatible version.",
    detail: version ? `The prepared runtime reported Claude Code ${version}.` : "The prepared runtime did not report its version.",
  } };
  return { command, version, check: {
    code: "claude_runtime_prepared", level: "info",
    message: `Paperclip prepared Claude Code ${version} for the selected model.`,
  } };
}
