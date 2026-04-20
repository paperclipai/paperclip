/**
 * Environment test for the copilot_local adapter.
 *
 * Checks:
 * 1. Working directory validity
 * 2. Binary check — is `copilot` (or config.command) resolvable?
 * 3. Version check — parse version from `copilot --version`
 * 4. Auth check — resolve a Copilot token via local auth helpers
 * 5. GHE connectivity (only when gheHost is configured)
 */
import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import {
  asString,
  parseObject,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensurePathInEnv,
  runChildProcess,
} from "@paperclipai/adapter-utils/server-utils";
import { isCopilotAuthError, resolveCopilotToken } from "./auth.js";
import path from "node:path";
import { parseCopilotLocalJsonl } from "./parse.js";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function commandLooksLike(command: string, expected: string): boolean {
  const base = path.basename(command).toLowerCase();
  return base === expected || base === `${expected}.cmd` || base === `${expected}.exe`;
}

function summarizeProbeDetail(stdout: string, stderr: string, parsedError: string | null): string | null {
  const raw = parsedError?.trim() || firstNonEmptyLine(stderr) || firstNonEmptyLine(stdout);
  if (!raw) return null;
  const clean = raw.replace(/\s+/g, " ").trim();
  const max = 240;
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const command = asString(config.command, "copilot");
  const cwd = asString(config.cwd, process.cwd());
  const gheHost = asString(config.gheHost, "");

  // ── Check 1: Working directory ──────────────────────────────────────
  try {
    await ensureAbsoluteDirectory(cwd, { createIfMissing: true });
    checks.push({
      code: "copilot_local_cwd_valid",
      level: "info",
      message: `Working directory is valid: ${cwd}`,
    });
  } catch (err) {
    checks.push({
      code: "copilot_local_cwd_invalid",
      level: "error",
      message: err instanceof Error ? err.message : "Invalid working directory",
      detail: cwd,
    });
  }

  // ── Build merged env ────────────────────────────────────────────────
  const envConfig = parseObject(config.env);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }
  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });

  // ── Check 2: Binary / command resolvable ────────────────────────────
  try {
    await ensureCommandResolvable(command, cwd, runtimeEnv);
    checks.push({
      code: "copilot_local_command_resolvable",
      level: "info",
      message: `Command is executable: ${command}`,
    });
  } catch (err) {
    checks.push({
      code: "copilot_local_command_unresolvable",
      level: "error",
      message: err instanceof Error ? err.message : "Command is not executable",
      detail: command,
      hint: "Install the GitHub Copilot CLI: https://docs.github.com/en/copilot/github-copilot-in-the-cli",
    });
  }

  // ── Check 3: Version probe ──────────────────────────────────────────
  const canProbe = checks.every(
    (c) => c.code !== "copilot_local_cwd_invalid" && c.code !== "copilot_local_command_unresolvable",
  );

  if (canProbe) {
    try {
      const versionResult = await runChildProcess(
        `copilot-local-version-${Date.now()}`,
        command,
        ["--version"],
        {
          cwd,
          env,
          timeoutSec: 10,
          graceSec: 3,
          onLog: async () => {},
        },
      );
      const versionLine = firstNonEmptyLine(versionResult.stdout) || firstNonEmptyLine(versionResult.stderr);
      if ((versionResult.exitCode ?? 1) === 0 && versionLine) {
        checks.push({
          code: "copilot_local_version",
          level: "info",
          message: `Copilot CLI version: ${versionLine}`,
        });
      } else {
        checks.push({
          code: "copilot_local_version_unknown",
          level: "warn",
          message: "Could not determine Copilot CLI version.",
          detail: versionLine || `exit code ${versionResult.exitCode}`,
          hint: "Run `copilot --version` manually to check the installation.",
        });
      }
    } catch (err) {
      checks.push({
        code: "copilot_local_version_error",
        level: "warn",
        message: "Failed to query Copilot CLI version.",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── Check 4: Auth / token resolution ────────────────────────────────
  const mergedEnv: Record<string, string | undefined> = { ...process.env, ...env };
  try {
    const tokenResult = await resolveCopilotToken(mergedEnv, gheHost || undefined);
    if (tokenResult) {
      const maskedToken =
        tokenResult.token.length > 8
          ? `${tokenResult.token.slice(0, 4)}...${tokenResult.token.slice(-4)}`
          : "***";
      checks.push({
        code: "copilot_local_auth_ok",
        level: "info",
        message: `Copilot token resolved from ${tokenResult.source} (${maskedToken})`,
      });
    } else {
      checks.push({
        code: "copilot_local_auth_missing",
        level: "warn",
        message: "No Copilot token found. The Copilot CLI may not be authenticated.",
        hint: gheHost
          ? `Run \`gh auth login --hostname ${gheHost}\` or set COPILOT_GITHUB_TOKEN / GH_TOKEN.`
          : "Run `gh auth login` or set COPILOT_GITHUB_TOKEN / GH_TOKEN / GITHUB_TOKEN.",
      });
    }
  } catch (err) {
    checks.push({
      code: "copilot_local_auth_error",
      level: "warn",
      message: "Failed to resolve Copilot token.",
      detail: err instanceof Error ? err.message : String(err),
      hint: gheHost
        ? `Run \`gh auth login --hostname ${gheHost}\` to authenticate.`
        : "Run `gh auth login` to authenticate with GitHub.",
    });
  }

  // ── Check 5: GHE connectivity (only if gheHost configured) ──────────
  if (gheHost) {
    checks.push({
      code: "copilot_local_ghe_configured",
      level: "info",
      message: `GitHub Enterprise host configured: ${gheHost}`,
    });

    try {
      const gheApiUrl = `https://${gheHost}/api/v3`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      const response = await fetch(gheApiUrl, {
        method: "HEAD",
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (response.ok || response.status === 401 || response.status === 403) {
        // 401/403 means the host is reachable but needs auth — that's fine for a connectivity check
        checks.push({
          code: "copilot_local_ghe_reachable",
          level: "info",
          message: `GitHub Enterprise host is reachable: ${gheHost}`,
        });
      } else {
        checks.push({
          code: "copilot_local_ghe_unexpected_status",
          level: "warn",
          message: `GitHub Enterprise host returned HTTP ${response.status}.`,
          detail: gheApiUrl,
          hint: `Verify the GHE hostname is correct: ${gheHost}`,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("abort")) {
        checks.push({
          code: "copilot_local_ghe_timeout",
          level: "warn",
          message: `GitHub Enterprise connectivity check timed out after 10s.`,
          hint: `Verify that ${gheHost} is reachable from this machine.`,
        });
      } else {
        checks.push({
          code: "copilot_local_ghe_unreachable",
          level: "warn",
          message: `Cannot reach GitHub Enterprise host: ${message}`,
          detail: gheHost,
          hint: "Check your network connection and verify the GHE hostname.",
        });
      }
    }
  }

  // ── Check 6: Hello probe (if binary and cwd are OK) ─────────────────
  if (canProbe) {
    if (!commandLooksLike(command, "copilot")) {
      checks.push({
        code: "copilot_local_hello_probe_skipped",
        level: "info",
        message: "Skipped hello probe because command is not `copilot`.",
        detail: command,
        hint: "Use the `copilot` CLI command to run the automatic probe.",
      });
    } else {
      try {
        const args = ["-p", "--output-format", "json", "-"];
        const probe = await runChildProcess(
          `copilot-local-envtest-${Date.now()}-${Math.random().toString(16).slice(2)}`,
          command,
          args,
          {
            cwd,
            env,
            timeoutSec: 45,
            graceSec: 5,
            stdin: "Respond with hello.",
            onLog: async () => {},
          },
        );

        const parsed = parseCopilotLocalJsonl(probe.stdout);
        const detail = summarizeProbeDetail(probe.stdout, probe.stderr, parsed.errorMessage);
        const authEvidence = `${parsed.errorMessage ?? ""}\n${probe.stdout}\n${probe.stderr}`.trim();

        if (probe.timedOut) {
          checks.push({
            code: "copilot_local_hello_probe_timed_out",
            level: "warn",
            message: "Copilot hello probe timed out.",
            hint: "Retry the probe. If this persists, verify Copilot can run from this directory manually.",
          });
        } else if (isCopilotAuthError(parsed.errorMessage, probe.stdout, probe.stderr)) {
          checks.push({
            code: "copilot_local_hello_probe_auth_required",
            level: "warn",
            message: "Copilot CLI is installed, but authentication is not ready.",
            ...(detail ? { detail } : {}),
            hint: gheHost
              ? `Run \`gh auth login --hostname ${gheHost}\` to authenticate, then retry.`
              : "Run `gh auth login` or set COPILOT_GITHUB_TOKEN, then retry the probe.",
          });
        } else if ((probe.exitCode ?? 1) === 0) {
          const summary = parsed.summary.trim();
          const hasHello = /\bhello\b/i.test(summary);
          checks.push({
            code: hasHello ? "copilot_local_hello_probe_passed" : "copilot_local_hello_probe_unexpected_output",
            level: hasHello ? "info" : "warn",
            message: hasHello
              ? "Copilot hello probe succeeded."
              : "Copilot probe ran but did not return `hello` as expected.",
            ...(summary ? { detail: summary.replace(/\s+/g, " ").trim().slice(0, 240) } : {}),
            ...(hasHello
              ? {}
              : {
                  hint: "Try the probe manually (`copilot -p --output-format json -`) and prompt `Respond with hello`.",
                }),
          });
        } else {
          checks.push({
            code: "copilot_local_hello_probe_failed",
            level: "error",
            message: "Copilot hello probe failed.",
            ...(detail ? { detail } : {}),
            hint: "Run `copilot -p --output-format json -` manually and prompt `Respond with hello` to debug.",
          });
        }
      } catch (err) {
        checks.push({
          code: "copilot_local_hello_probe_error",
          level: "warn",
          message: "Copilot hello probe encountered an unexpected error.",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
