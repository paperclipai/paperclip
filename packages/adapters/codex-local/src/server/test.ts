import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import {
  asString,
  parseObject,
  parseJson,
  ensurePathInEnv,
} from "@paperclipai/adapter-utils/server-utils";
import {
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetDirectory,
  maybeRunSandboxInstallCommand,
  overrideAdapterExecutionTargetRemoteCwd,
  runAdapterExecutionTargetProcess,
  describeAdapterExecutionTarget,
  resolveAdapterExecutionTargetCwd,
} from "@paperclipai/adapter-utils/execution-target";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { parseCodexJsonl } from "./parse.js";
import { SANDBOX_INSTALL_COMMAND } from "../index.js";
import { readCodexAuthInfo } from "./quota.js";
import { buildCodexExecArgs } from "./codex-args.js";
import { prepareManagedCodexHome } from "./codex-home.js";
import { resolveCodexExecutionEngineForRun, testCodexAcpEnvironment } from "./acp.js";
import { ADAPTER_AUTH_MISSING_CHECK_CODE } from "./auth-check.js";
import {
  classifyCodexProbeAuth,
  snapshotDurableCodexProbeAuth,
} from "./codex-probe-auth.js";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isCanonicalCodexCommand(command: string): boolean {
  return command.trim() === "codex";
}

function inspectCodexProbeProtocol(stdout: string): { valid: boolean; succeeded: boolean } {
  const safeItemTypes = new Set(["reasoning", "agent_message"]);
  let valid = true;
  let threadSeen = false;
  let turnStarted = false;
  let helloCount = 0;
  let successfulTerminalCount = 0;
  let terminalSeen = false;
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const event = parseJson(line);
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      valid = false;
      continue;
    }
    const type = asString(event.type, "");
    if (!type || terminalSeen) {
      valid = false;
      continue;
    }
    if (type === "error" || type === "turn.failed") {
      valid = false;
      terminalSeen = true;
      continue;
    }
    if (type === "thread.started") {
      if (threadSeen || helloCount > 0 || !isNonEmpty(event.thread_id)) valid = false;
      threadSeen = true;
      continue;
    }
    if (type === "turn.started") {
      if (!threadSeen || turnStarted || helloCount > 0) valid = false;
      turnStarted = true;
      continue;
    }
    if (type === "item.completed") {
      if (
        !threadSeen ||
        !event.item ||
        typeof event.item !== "object" ||
        Array.isArray(event.item)
      ) {
        valid = false;
        continue;
      }
      const item = parseObject(event.item);
      const itemType = asString(item.type, "");
      if (!safeItemTypes.has(itemType)) {
        valid = false;
      } else if (itemType === "agent_message") {
        helloCount += 1;
        if (asString(item.text, "").trim() !== "Hello.") valid = false;
      }
      continue;
    }
    if (type === "item.started" || type === "item.updated") {
      if (
        !threadSeen ||
        !event.item ||
        typeof event.item !== "object" ||
        Array.isArray(event.item) ||
        !safeItemTypes.has(asString(parseObject(event.item).type, ""))
      ) {
        valid = false;
      }
      continue;
    }
    if (type === "turn.completed") {
      terminalSeen = true;
      successfulTerminalCount += 1;
      if (!threadSeen || helloCount !== 1) valid = false;
      continue;
    }
    valid = false;
  }
  return {
    valid,
    succeeded: valid && helloCount === 1 && successfulTerminalCount === 1,
  };
}

const CODEX_PROBE_AUTH_ENV_KEY_NAMES = [
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "CODEX_AUTH_JSON",
  "_PAPERCLIP_CODEX_AUTH_JSON",
] as const;
const CODEX_PROBE_AUTH_ENV_KEYS = new Set<string>(CODEX_PROBE_AUTH_ENV_KEY_NAMES);
const CODEX_PROBE_PREPARATION_CLEANUP_FAILED =
  "codex_probe_preparation_cleanup_failed";

function stripCodexProbeAuthEnv(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => !CODEX_PROBE_AUTH_ENV_KEYS.has(key.toUpperCase())),
  );
}

const CODEX_PROBE_HOME_STAGE_SCRIPT = [
  "set -eu",
  "umask 077",
  `node -e '${[
    'const fs=require("node:fs")',
    'const path=require("node:path")',
    'const home=process.env.CODEX_HOME',
    'const workspace=process.env.PAPERCLIP_CODEX_PROBE_WORKSPACE',
    'if(!home||!workspace)throw new Error("missing probe paths")',
    'const root=path.dirname(home)',
    'fs.mkdirSync(root,{mode:0o700})',
    'const rootStat=fs.lstatSync(root)',
    'if(!rootStat.isDirectory()||rootStat.isSymbolicLink())throw new Error("invalid probe root")',
    'fs.mkdirSync(home,{mode:0o700})',
    'fs.mkdirSync(workspace,{mode:0o700})',
    'for(const candidate of [home,workspace]){const stat=fs.lstatSync(candidate);if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error("invalid probe directory")}',
    'const payload=JSON.parse(fs.readFileSync(0,"utf8"))',
    'if(payload.authJson!==null&&typeof payload.authJson!=="string")throw new Error("invalid auth payload")',
    'if(typeof payload.authJson==="string")fs.writeFileSync(path.join(home,"auth.json"),Buffer.from(payload.authJson,"base64"),{mode:0o600,flag:"wx"})',
  ].join(";")}'`,
  'cd "$PAPERCLIP_CODEX_PROBE_WORKSPACE"',
  "unset PAPERCLIP_CODEX_PROBE_WORKSPACE",
  'printf "%s\\n" "Reply with exactly Hello. Do not use tools." | "$@"',
].join("; ");

const CODEX_AUTH_REQUIRED_RE =
  /(?:not\s+logged\s+in|login\s+required|authentication\s+required|unauthorized|invalid(?:\s+or\s+missing)?\s+api(?:[_\s-]?key)?|openai[_\s-]?api[_\s-]?key|api[_\s-]?key.*required|please\s+run\s+`?codex\s+login`?)/i;

async function prepareCodexHelloProbe(input: {
  runId: string;
  companyId: string;
  target: AdapterEnvironmentTestContext["executionTarget"] | null;
  targetIsRemote: boolean;
  cwd: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  probeApiKey: string | null;
  probeAuthJson: string | null;
}): Promise<{
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  stdin: string;
  cleanup: () => Promise<boolean>;
}> {
  let probeAuthRootLocalDir: string | null = null;
  let probeAuthRootRemoteDir: string | null = null;

  const cleanup = async () => {
    let succeeded = true;
    if (probeAuthRootRemoteDir) {
      const cleanupTarget = input.target?.kind === "remote"
        ? input.target.transport === "sandbox"
          ? { ...input.target, remoteCwd: "/tmp" }
          : {
              ...input.target,
              remoteCwd: "/tmp",
              spec: { ...input.target.spec, remoteCwd: "/tmp" },
            }
        : input.target;
      try {
        const removal = await runAdapterExecutionTargetProcess(
          `${input.runId}-cleanup`,
          cleanupTarget,
          "rm",
          ["-rf", "--", probeAuthRootRemoteDir],
          {
            cwd: "/tmp",
            env: {},
            denyEnvironmentKeys: CODEX_PROBE_AUTH_ENV_KEY_NAMES,
            timeoutSec: 15,
            graceSec: 5,
            onLog: async () => {},
          },
        );
        if (removal.timedOut || (removal.exitCode ?? 1) !== 0) succeeded = false;
      } catch {
        succeeded = false;
      }
      try {
        const verification = await runAdapterExecutionTargetProcess(
          `${input.runId}-cleanup-verify`,
          cleanupTarget,
          "sh",
          ["-c", '[ ! -e "$1" ] && [ ! -L "$1" ]', "sh", probeAuthRootRemoteDir],
          {
            cwd: "/tmp",
            env: {},
            denyEnvironmentKeys: CODEX_PROBE_AUTH_ENV_KEY_NAMES,
            timeoutSec: 15,
            graceSec: 5,
            onLog: async () => {},
          },
        );
        if (verification.timedOut || (verification.exitCode ?? 1) !== 0) succeeded = false;
      } catch {
        succeeded = false;
      }
    }
    if (probeAuthRootLocalDir) {
      try {
        await fs.rm(probeAuthRootLocalDir, { recursive: true, force: true });
        const remaining = await fs.lstat(probeAuthRootLocalDir).catch(() => null);
        if (remaining) succeeded = false;
      } catch {
        succeeded = false;
      }
    }
    return succeeded;
  };

  let authJson: Buffer | null = input.probeApiKey
    ? Buffer.from(JSON.stringify({ OPENAI_API_KEY: input.probeApiKey }), "utf8")
      : input.probeAuthJson
      ? Buffer.from(input.probeAuthJson, "utf8")
      : null;

  if (authJson && classifyCodexProbeAuth(authJson) !== "api_key") {
    throw new Error("codex_probe_nonpersistent_subscription_auth_unsupported");
  }

  if (!authJson && input.targetIsRemote) {
    const managedHome = await prepareManagedCodexHome(process.env, async () => {}, input.companyId, {
      apiKey: null,
    });
    const authSnapshot = await snapshotDurableCodexProbeAuth(managedHome).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    authJson = authSnapshot?.bytes ?? null;
    if (authSnapshot) {
      if (authSnapshot.kind === "subscription") {
        throw new Error("codex_probe_remote_subscription_auth_unsupported");
      }
      if (authSnapshot.kind === "unsupported") {
        throw new Error("codex_probe_auth_format_unsupported");
      }
    }
  }

  const sanitizedEnv = stripCodexProbeAuthEnv(input.env);
  if (input.targetIsRemote) {
    const probeRoot = path.posix.join("/tmp", `paperclip-codex-probe-${input.runId}`);
    const probeHome = path.posix.join(probeRoot, "home");
    const probeWorkspace = path.posix.join(probeRoot, "workspace");
    probeAuthRootRemoteDir = probeRoot;
    return {
      command: "sh",
      args: [
        "-c",
        CODEX_PROBE_HOME_STAGE_SCRIPT,
        "paperclip-codex-probe",
        input.command,
        ...input.args,
      ],
      env: {
        ...sanitizedEnv,
        CODEX_HOME: probeHome,
        PAPERCLIP_CODEX_PROBE_WORKSPACE: probeWorkspace,
      },
      cwd: input.cwd,
      stdin: JSON.stringify({
        authJson: authJson?.toString("base64") ?? null,
      }),
      cleanup,
    };
  }

  const probeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-probe-"));
  probeAuthRootLocalDir = probeRoot;
  try {
    const probeWorkspace = path.join(probeRoot, "workspace");
    await fs.mkdir(probeWorkspace, { mode: 0o700 });
    let probeEnv = sanitizedEnv;
    if (authJson) {
      const probeHome = path.join(probeRoot, "home");
      await fs.mkdir(probeHome, { mode: 0o700 });
      await fs.writeFile(path.join(probeHome, "auth.json"), authJson, {
        mode: 0o600,
        flag: "wx",
      });
      probeEnv = { ...sanitizedEnv, CODEX_HOME: probeHome };
    }
    return {
      command: input.command,
      args: input.args,
      env: probeEnv,
      cwd: probeWorkspace,
      stdin: "Reply with exactly Hello. Do not use tools.",
      cleanup,
    };
  } catch (error) {
    const cleanupSucceeded = await cleanup().catch(() => false);
    if (!cleanupSucceeded) {
      throw new Error(CODEX_PROBE_PREPARATION_CLEANUP_FAILED);
    }
    throw error;
  }
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const engineSelection = await resolveCodexExecutionEngineForRun({
    config: parseObject(ctx.config),
    executionTarget: ctx.executionTarget,
  });
  if (engineSelection.engine === "acp") {
    return testCodexAcpEnvironment(ctx);
  }

  let checks: AdapterEnvironmentCheck[] = [];
  if (!engineSelection.explicit && engineSelection.fallbackReason) {
    checks.push({
      code: "codex_acp_default_fallback",
      level: "warn",
      message: "Codex ACP default is unavailable; testing the Codex CLI fallback lane.",
      hint: "Fix the ACP prerequisite to use the default ACP lane, or explicitly select the CLI lane.",
    });
  }
  const config = parseObject(ctx.config);
  const command = asString(config.command, "codex");
  const target = ctx.executionTarget ?? null;
  const targetIsRemote = target?.kind === "remote";
  const targetIsSandbox = target?.kind === "remote" && target.transport === "sandbox";
  const cwd = resolveAdapterExecutionTargetCwd(target, asString(config.cwd, ""), process.cwd());
  const cwdBoundTarget = targetIsSandbox && target
    ? { ...target, remoteCwd: cwd }
    : target;
  const targetLabel = targetIsRemote
    ? ctx.environmentName ?? describeAdapterExecutionTarget(target)
    : null;
  const runId = `codex-envtest-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  if (targetLabel) {
    checks.push({
      code: "codex_environment_target",
      level: "info",
      message: "Probing inside the selected execution environment.",
    });
  }

  try {
    await ensureAdapterExecutionTargetDirectory(runId, cwdBoundTarget, cwd, {
      cwd,
      env: {},
      createIfMissing: true,
    });
    checks.push({
      code: "codex_cwd_valid",
      level: "info",
      message: "Working directory is valid.",
    });
  } catch {
    checks.push({
      code: "codex_cwd_invalid",
      level: "error",
      message: "Working directory is invalid or inaccessible.",
    });
  }

  const envConfig = parseObject(config.env);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }
  const inheritedEnv = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] =>
      typeof entry[1] === "string"
    ),
  );
  const sanitizedProbeEnv = stripCodexProbeAuthEnv(env);
  const runtimeEnv = ensurePathInEnv(stripCodexProbeAuthEnv({ ...inheritedEnv, ...env }));
  const installCheck = await maybeRunSandboxInstallCommand({
    runId,
    target: cwdBoundTarget,
    adapterKey: "codex",
    installCommand: SANDBOX_INSTALL_COMMAND,
    detectCommand: command,
    env: sanitizedProbeEnv,
  });
  if (installCheck) {
    checks.push({
      code: installCheck.code,
      level: installCheck.level,
      message:
        installCheck.level === "warn"
          ? "Codex installation check needs attention."
          : "Codex installation check completed.",
      ...(installCheck.level === "warn"
        ? { hint: "Verify that the Codex CLI is installed in the selected sandbox." }
        : {}),
    });
  }
  try {
    await ensureAdapterExecutionTargetCommandResolvable(command, cwdBoundTarget, cwd, runtimeEnv);
    checks.push({
      code: "codex_command_resolvable",
      level: "info",
      message: "Codex command is executable.",
    });
  } catch {
    checks.push({
      code: "codex_command_unresolvable",
      level: "error",
      message: "Codex command is not executable.",
    });
  }

  const configAuthJson = isNonEmpty(env.CODEX_AUTH_JSON)
    ? env.CODEX_AUTH_JSON
    : isNonEmpty(env._PAPERCLIP_CODEX_AUTH_JSON)
      ? env._PAPERCLIP_CODEX_AUTH_JSON
      : null;
  const configApiKey = isNonEmpty(env.OPENAI_API_KEY)
    ? env.OPENAI_API_KEY
    : isNonEmpty(env.CODEX_API_KEY)
      ? env.CODEX_API_KEY
      : null;
  const hostApiKey = targetIsRemote
    ? null
    : isNonEmpty(process.env.OPENAI_API_KEY)
      ? process.env.OPENAI_API_KEY
      : isNonEmpty(process.env.CODEX_API_KEY)
        ? process.env.CODEX_API_KEY
        : null;
  if (configAuthJson || configApiKey || hostApiKey) {
    checks.push({
      code: "codex_openai_api_key_present",
      level: "info",
      message: "OPENAI_API_KEY is set for Codex authentication.",
    });
  } else if (!targetIsRemote) {
    // Local-only auth file check. On remote targets, the probe will surface
    // any missing-auth errors directly from the remote `codex` invocation.
    const codexHome = isNonEmpty(env.CODEX_HOME) ? env.CODEX_HOME : undefined;
    const codexAuth = await readCodexAuthInfo(codexHome).catch(() => null);
    if (codexAuth) {
      checks.push({
        code: "codex_native_auth_present",
        level: "info",
        message: "Codex is authenticated via its own auth configuration.",
      });
    } else {
      checks.push({
        code: "codex_openai_api_key_missing",
        level: "warn",
        message: "OPENAI_API_KEY is not set. Codex runs may fail until authentication is configured.",
        hint: "Set OPENAI_API_KEY in adapter env, shell environment, or run `codex auth` to log in.",
      });
    }
  }

  const canRunProbe =
    checks.every((check) => check.code !== "codex_cwd_invalid" && check.code !== "codex_command_unresolvable");
  if (canRunProbe) {
    if (!isCanonicalCodexCommand(command)) {
      checks.push({
        code: "codex_hello_probe_skipped_custom_command",
        level: "warn",
        message: "Skipped hello probe because command is not `codex`.",
        hint: "Use the `codex` CLI command to run the automatic login and installation probe.",
      });
    } else {
      const execArgs = buildCodexExecArgs(
        {
          ...config,
          fastMode: false,
          search: false,
          dangerouslyBypassApprovalsAndSandbox: false,
          dangerouslyBypassSandbox: false,
          extraArgs: [],
          args: [],
        },
        { skipGitRepoCheck: targetIsSandbox },
      );
      const args = execArgs.args;
      if (execArgs.fastModeIgnoredReason) {
        checks.push({
          code: "codex_fast_mode_unsupported_model",
          level: "warn",
          message: "Codex Fast mode is unavailable for the selected model.",
          hint: "Switch the agent model to GPT-5.4 or enter a manual model ID to enable Codex Fast mode.",
        });
      }
      if (targetIsSandbox) {
        checks.push({
          code: "codex_git_repo_check_skipped",
          level: "info",
          message: "Added --skip-git-repo-check for sandbox hello probes.",
          hint: "Codex requires an explicit trust bypass in headless remote sandbox workspaces.",
        });
      }

      // Codex CLI (>= 0.122) ignores the OPENAI_API_KEY env var and only reads
      // credentials from $CODEX_HOME/auth.json. When we have a key available,
      // materialize a per-run auth.json from stdin. Credential bytes never
      // enter argv or a child environment.
      const probeAuthJson = configAuthJson;
      const probeApiKey = probeAuthJson ? null : configApiKey ?? hostApiKey;
      const probeCheckStart = checks.length;
      let preparedProbe: Awaited<ReturnType<typeof prepareCodexHelloProbe>> | null = null;
      let cleanupSucceeded = true;
      try {
          preparedProbe = await prepareCodexHelloProbe({
          runId,
          companyId: ctx.companyId,
          target: cwdBoundTarget,
          targetIsRemote,
          cwd,
          command,
          args,
          env,
          probeApiKey,
          probeAuthJson,
        });
          cleanupSucceeded = false;
          try {
          const probeExecutionTarget = targetIsRemote
            ? overrideAdapterExecutionTargetRemoteCwd(cwdBoundTarget, preparedProbe.cwd)
            : cwdBoundTarget;
          const probe = await runAdapterExecutionTargetProcess(
            runId,
            probeExecutionTarget,
            preparedProbe.command,
            preparedProbe.args,
            {
              cwd: preparedProbe.cwd,
              env: preparedProbe.env,
              denyEnvironmentKeys: CODEX_PROBE_AUTH_ENV_KEY_NAMES,
              timeoutSec: 45,
              graceSec: 5,
              stdin: preparedProbe.stdin,
              onLog: async () => {},
            },
          );
          const parsed = parseCodexJsonl(probe.stdout);
          const protocol = inspectCodexProbeProtocol(probe.stdout);
          const authEvidence = `${parsed.errorMessage ?? ""}\n${probe.stdout}\n${probe.stderr}`.trim();

          if (probe.timedOut) {
            checks.push({
              code: "codex_hello_probe_timed_out",
              level: "warn",
              message: "Codex hello probe timed out.",
              hint: "Retry the probe. If this persists, verify Codex can reply with exactly `Hello.` from this directory manually.",
            });
          } else if (
            (probe.exitCode ?? 1) === 0 &&
            protocol.succeeded &&
            !parsed.errorMessage
          ) {
            const summary = parsed.summary.trim();
            const hasHello = summary === "Hello.";
            checks.push({
              code: hasHello ? "codex_hello_probe_passed" : "codex_hello_probe_unexpected_output",
              level: hasHello ? "info" : "warn",
              message: hasHello
                ? "Codex hello probe succeeded."
                : "Codex probe ran but did not return `hello` as expected.",
              ...(hasHello ? { detail: "Hello." } : {}),
              ...(hasHello
                ? {}
                : {
                    hint: "Try the probe manually (`codex exec --json -` then prompt: Reply with exactly Hello.) to inspect full output.",
                  }),
            });
          } else if (!protocol.valid) {
            checks.push({
              code: "codex_hello_probe_failed",
              level: "error",
              message: "Codex hello probe failed.",
              hint: "Retry the live test after verifying the selected Codex CLI installation.",
            });
          } else if ((probe.exitCode ?? 1) !== 0 && CODEX_AUTH_REQUIRED_RE.test(authEvidence)) {
            checks.push({
              code: "codex_hello_probe_auth_required",
              level: "warn",
              message: "Codex CLI is installed, but authentication is not ready.",
              hint: probeApiKey
                ? "OPENAI_API_KEY was provided but Codex still rejected the request. Verify the key is valid for the OpenAI Responses API (e.g. `curl -H \"Authorization: Bearer $OPENAI_API_KEY\" https://api.openai.com/v1/models`), or run `codex login` and seed `~/.codex/auth.json`."
                : "Codex CLI does not read OPENAI_API_KEY from the environment; set OPENAI_API_KEY in this adapter's config (so Paperclip writes it to `$CODEX_HOME/auth.json`) or run `codex login` on the host first.",
            });
            if (targetIsSandbox) {
              checks.push({
                code: ADAPTER_AUTH_MISSING_CHECK_CODE,
                level: "warn",
                message: "This environment has no ready authentication for this adapter.",
                hint: "Provide credentials for this adapter, or start login in the environment.",
              });
            }
          } else {
            checks.push({
              code: "codex_hello_probe_failed",
              level: "error",
              message: "Codex hello probe failed.",
              hint: "Run `codex exec --json -` manually in this working directory and prompt `Reply with exactly Hello.` to debug.",
            });
          }
        } catch {
          checks.push({
            code: "codex_hello_probe_failed",
            level: "error",
            message: "Codex hello probe failed.",
            hint: "Retry the live test after verifying the selected Codex CLI installation.",
          });
        } finally {
          cleanupSucceeded = await preparedProbe.cleanup().catch(() => false);
        }
      } catch (error) {
        if (!preparedProbe) {
          if (
            error instanceof Error &&
            error.message === CODEX_PROBE_PREPARATION_CLEANUP_FAILED
          ) {
            cleanupSucceeded = false;
          }
          checks.push({
            code: "codex_hello_probe_failed",
            level: "error",
            message: "Codex hello probe failed.",
            hint: "Retry the live test after verifying the selected Codex CLI installation.",
          });
        }
      }
      if (!cleanupSucceeded) {
        checks = [
          ...checks.slice(0, probeCheckStart),
          {
            code: "codex_hello_probe_cleanup_failed",
            level: "error",
            message: "Codex replied, but environment cleanup did not complete safely.",
            hint: "Retry the live test after checking the selected environment's runtime health.",
          },
        ];
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
