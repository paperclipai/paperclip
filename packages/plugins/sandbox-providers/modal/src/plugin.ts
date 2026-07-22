import {
  ModalClient,
  NotFoundError,
  SandboxTimeoutError,
  TimeoutError,
  type App,
  type ContainerProcess,
  type Sandbox,
  type SandboxCreateParams,
} from "modal";
import { definePlugin } from "@paperclipai/plugin-sdk";
import type {
  PluginEnvironmentAcquireLeaseParams,
  PluginEnvironmentDestroyLeaseParams,
  PluginEnvironmentExecuteParams,
  PluginEnvironmentExecuteResult,
  PluginEnvironmentLease,
  PluginEnvironmentProbeParams,
  PluginEnvironmentProbeResult,
  PluginEnvironmentRealizeWorkspaceParams,
  PluginEnvironmentRealizeWorkspaceResult,
  PluginEnvironmentReleaseLeaseParams,
  PluginEnvironmentResumeLeaseParams,
  PluginEnvironmentValidateConfigParams,
  PluginEnvironmentValidationResult,
} from "@paperclipai/plugin-sdk";

const DEFAULT_WORKDIR = "/workspace/paperclip";
const DEFAULT_SANDBOX_TIMEOUT_MS = 3_600_000;
const DEFAULT_EXEC_TIMEOUT_MS = 300_000;
const MAX_SANDBOX_TIMEOUT_MS = 86_400_000;

interface ModalDriverConfig {
  appName: string;
  image: string;
  tokenId: string | null;
  tokenSecret: string | null;
  environment: string | null;
  workdir: string;
  sandboxTimeoutMs: number;
  idleTimeoutMs: number | null;
  execTimeoutMs: number;
  blockNetwork: boolean;
  cidrAllowlist: string[] | null;
  reuseLease: boolean;
}

function parseOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function parseOptionalNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const trimmed = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return trimmed.length > 0 ? trimmed : null;
}

export function parseDriverConfig(raw: Record<string, unknown>): ModalDriverConfig {
  const sandboxTimeoutMsRaw = parseOptionalNumber(raw.sandboxTimeoutMs);
  const execTimeoutMsRaw = parseOptionalNumber(raw.execTimeoutMs);
  const idleTimeoutMsRaw = parseOptionalNumber(raw.idleTimeoutMs);
  return {
    appName: parseOptionalString(raw.appName) ?? "",
    image: parseOptionalString(raw.image) ?? "",
    tokenId: parseOptionalString(raw.tokenId),
    tokenSecret: parseOptionalString(raw.tokenSecret),
    environment: parseOptionalString(raw.environment),
    workdir: parseOptionalString(raw.workdir) ?? DEFAULT_WORKDIR,
    sandboxTimeoutMs:
      sandboxTimeoutMsRaw != null ? Math.trunc(sandboxTimeoutMsRaw) : DEFAULT_SANDBOX_TIMEOUT_MS,
    idleTimeoutMs: idleTimeoutMsRaw != null ? Math.trunc(idleTimeoutMsRaw) : null,
    execTimeoutMs:
      execTimeoutMsRaw != null ? Math.trunc(execTimeoutMsRaw) : DEFAULT_EXEC_TIMEOUT_MS,
    blockNetwork: raw.blockNetwork === true,
    cidrAllowlist: parseStringArray(raw.cidrAllowlist),
    reuseLease: raw.reuseLease === true,
  };
}

function isMultipleOf1000(value: number): boolean {
  return value > 0 && value % 1000 === 0;
}

function resolveAuth(config: ModalDriverConfig): { tokenId: string; tokenSecret: string } | null {
  // The plugin worker runs in a child process that does not inherit host env
  // vars (see PluginWorkerManager.spawnProcess), so MODAL_TOKEN_ID /
  // MODAL_TOKEN_SECRET cannot be read here. Credentials must come from the
  // environment config, which Paperclip stores as company secrets.
  const tokenId = config.tokenId ?? "";
  const tokenSecret = config.tokenSecret ?? "";
  if (!tokenId && !tokenSecret) return null;
  if (!tokenId || !tokenSecret) {
    throw new Error("Modal sandbox environments require both tokenId and tokenSecret to be configured.");
  }
  return { tokenId, tokenSecret };
}

function createModalClient(config: ModalDriverConfig): ModalClient {
  const auth = resolveAuth(config);
  const params: ConstructorParameters<typeof ModalClient>[0] = {};
  if (auth) {
    params.tokenId = auth.tokenId;
    params.tokenSecret = auth.tokenSecret;
  }
  if (config.environment) {
    params.environment = config.environment;
  }
  return new ModalClient(params);
}

async function resolveApp(client: ModalClient, config: ModalDriverConfig): Promise<App> {
  return await client.apps.fromName(config.appName, {
    createIfMissing: true,
    environment: config.environment ?? undefined,
  });
}

function buildSandboxCreateParams(input: {
  config: ModalDriverConfig;
  tags: Record<string, string>;
}): SandboxCreateParams {
  const params: SandboxCreateParams = {
    workdir: input.config.workdir,
    timeoutMs: input.config.sandboxTimeoutMs,
    blockNetwork: input.config.blockNetwork,
  };
  if (input.config.idleTimeoutMs != null) {
    params.idleTimeoutMs = input.config.idleTimeoutMs;
  }
  if (input.config.cidrAllowlist && input.config.cidrAllowlist.length > 0) {
    params.cidrAllowlist = input.config.cidrAllowlist;
  }
  // Modal sandboxes accept tag metadata via setTags after creation; the create
  // RPC does not take tags directly. We pass them through input so the caller
  // can apply them after `create` resolves.
  void input.tags;
  return params;
}

function buildSandboxTags(input: {
  companyId: string;
  environmentId: string;
  runId?: string;
  reuseLease: boolean;
}): Record<string, string> {
  return {
    "paperclip-provider": "modal",
    "paperclip-company-id": input.companyId,
    "paperclip-environment-id": input.environmentId,
    "paperclip-reuse-lease": input.reuseLease ? "true" : "false",
    ...(input.runId ? { "paperclip-run-id": input.runId } : {}),
  };
}

async function createSandboxFor(
  client: ModalClient,
  app: App,
  config: ModalDriverConfig,
  tags: Record<string, string>,
): Promise<Sandbox> {
  const image = client.images.fromRegistry(config.image);
  const params = buildSandboxCreateParams({ config, tags });
  const sandbox = await client.sandboxes.create(app, image, params);
  try {
    await sandbox.setTags(tags);
  } catch (error) {
    // setTags is best-effort metadata; surface but do not block lease creation.
    console.warn(`Failed to set tags on Modal sandbox ${sandbox.sandboxId}: ${formatErrorMessage(error)}`);
  }
  return sandbox;
}

function leaseMetadata(input: {
  config: ModalDriverConfig;
  sandbox: Sandbox;
  remoteCwd: string;
  resumedLease: boolean;
}) {
  return {
    provider: "modal",
    shellCommand: "sh",
    sandboxId: input.sandbox.sandboxId,
    appName: input.config.appName,
    image: input.config.image,
    sandboxTimeoutMs: input.config.sandboxTimeoutMs,
    idleTimeoutMs: input.config.idleTimeoutMs,
    reuseLease: input.config.reuseLease,
    remoteCwd: input.remoteCwd,
    resumedLease: input.resumedLease,
  };
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function isValidShellEnvKey(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

// Modal's `sandbox.exec` takes an argv array and bypasses the shell entirely,
// so adapter probes that rely on PATH mutations from /etc/profile or ~/.bashrc
// do not work without an explicit login shell. Mirroring the Daytona / E2B
// providers, wrap the user command in a `sh -lc` script that sources common
// login profiles plus nvm before invoking it. Env is set after profile sourcing
// so caller env wins; stdin is staged to a temp file and shell-redirected so
// fast-failing commands do not race a streaming stdin writer.
function buildLoginShellScript(input: {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdinPath?: string;
}): string {
  const env = input.env ?? {};
  for (const key of Object.keys(env)) {
    if (!isValidShellEnvKey(key)) {
      throw new Error(`Invalid sandbox environment variable key: ${key}`);
    }
  }
  const envArgs = Object.entries(env)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([key, value]) => `${key}=${shellQuote(value)}`);
  const commandParts = [shellQuote(input.command), ...input.args.map(shellQuote)].join(" ");
  const redirected = input.stdinPath
    ? `${commandParts} < ${shellQuote(input.stdinPath)}`
    : commandParts;
  const finalLine = envArgs.length > 0 ? `exec env ${envArgs.join(" ")} ${redirected}` : `exec ${redirected}`;
  const lines = [
    'if [ -f /etc/profile ]; then . /etc/profile >/dev/null 2>&1 || true; fi',
    'if [ -f "$HOME/.profile" ]; then . "$HOME/.profile" >/dev/null 2>&1 || true; fi',
    'if [ -f "$HOME/.bash_profile" ]; then . "$HOME/.bash_profile" >/dev/null 2>&1 || true; elif [ -f "$HOME/.bashrc" ]; then . "$HOME/.bashrc" >/dev/null 2>&1 || true; fi',
    'if [ -f "$HOME/.zprofile" ]; then . "$HOME/.zprofile" >/dev/null 2>&1 || true; fi',
    'export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"',
    '[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1 || true',
  ];
  if (input.cwd) {
    lines.push(`cd ${shellQuote(input.cwd)}`);
  }
  lines.push(finalLine);
  return lines.join(" && ");
}

async function ensureRemoteWorkspace(sandbox: Sandbox, remoteCwd: string): Promise<void> {
  // Use a one-shot exec to mkdir -p; Modal does not expose a direct
  // filesystem mkdir helper and creating a file via `open()` does not create
  // intermediate directories.
  const proc = await sandbox.exec(["sh", "-lc", `mkdir -p ${shellQuote(remoteCwd)}`]);
  const exitCode = await proc.wait();
  if (exitCode !== 0) {
    throw new Error(
      `Failed to create remote workspace directory '${remoteCwd}': mkdir exited with code ${exitCode}`,
    );
  }
}

async function stageStdin(sandbox: Sandbox, stdin: string, remotePath: string): Promise<void> {
  const file = await sandbox.open(remotePath, "w");
  try {
    await file.write(new TextEncoder().encode(stdin));
    await file.flush();
  } finally {
    await file.close().catch(() => undefined);
  }
}

async function deleteStdinPath(sandbox: Sandbox, remotePath: string): Promise<void> {
  // Best-effort cleanup of the staged stdin file. We swallow errors because
  // it is fine for the file to outlive the sandbox if it is going to be
  // terminated, and a missing rm tool would otherwise mask the real result.
  try {
    const proc = await sandbox.exec(["sh", "-lc", `rm -f ${shellQuote(remotePath)}`]);
    await proc.wait();
  } catch {
    // ignore
  }
}

async function readProcessStreams(
  proc: ContainerProcess<string>,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const [stdout, stderr, exitCode] = await Promise.all([
    proc.stdout.readText(),
    proc.stderr.readText(),
    proc.wait(),
  ]);
  return { stdout, stderr, exitCode };
}

function isModalNotFound(error: unknown): boolean {
  return error instanceof NotFoundError;
}

async function getSandboxOrNull(
  client: ModalClient,
  providerLeaseId: string,
): Promise<Sandbox | null> {
  try {
    return await client.sandboxes.fromId(providerLeaseId);
  } catch (error) {
    if (isModalNotFound(error)) return null;
    throw error;
  }
}

function warnIfUnsupportedNode(logger: { warn: (msg: string) => void } | undefined): void {
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  if (Number.isFinite(major) && major < 22) {
    const message = `Modal sandbox provider is running on Node ${process.versions.node}; Modal officially supports Node 22+. The plugin will attempt to operate but vendor support is not guaranteed below Node 22.`;
    logger?.warn(message);
  }
}

function leaseRemoteCwd(metadata: Record<string, unknown> | undefined, fallback: string): string {
  if (metadata && typeof metadata.remoteCwd === "string" && metadata.remoteCwd.trim().length > 0) {
    return metadata.remoteCwd.trim();
  }
  return fallback;
}

const plugin = definePlugin({
  async setup(ctx) {
    warnIfUnsupportedNode(ctx.logger);
    ctx.logger.info("Modal sandbox provider plugin ready");
  },

  async onHealth() {
    return { status: "ok", message: "Modal sandbox provider plugin healthy" };
  },

  async onEnvironmentValidateConfig(
    params: PluginEnvironmentValidateConfigParams,
  ): Promise<PluginEnvironmentValidationResult> {
    const config = parseDriverConfig(params.config);
    const errors: string[] = [];

    if (!config.appName) {
      errors.push("Modal sandbox environments require an appName.");
    }
    if (!config.image) {
      errors.push("Modal sandbox environments require an image reference.");
    }
    if (
      config.sandboxTimeoutMs < 1000 ||
      config.sandboxTimeoutMs > MAX_SANDBOX_TIMEOUT_MS ||
      !isMultipleOf1000(config.sandboxTimeoutMs)
    ) {
      errors.push(
        "sandboxTimeoutMs must be a positive multiple of 1000 between 1000 and 86400000.",
      );
    }
    if (
      config.idleTimeoutMs != null &&
      (config.idleTimeoutMs < 1000 || !isMultipleOf1000(config.idleTimeoutMs))
    ) {
      errors.push("idleTimeoutMs must be a positive multiple of 1000 when provided.");
    }
    if (config.execTimeoutMs < 1000 || !isMultipleOf1000(config.execTimeoutMs)) {
      errors.push("execTimeoutMs must be a positive multiple of 1000.");
    }
    if (config.blockNetwork && config.cidrAllowlist && config.cidrAllowlist.length > 0) {
      errors.push("cidrAllowlist cannot be combined with blockNetwork.");
    }
    const hasTokenId = Boolean(config.tokenId);
    const hasTokenSecret = Boolean(config.tokenSecret);
    if (hasTokenId !== hasTokenSecret) {
      errors.push("tokenId and tokenSecret must both be provided when either is set.");
    } else if (!hasTokenId) {
      errors.push("Modal sandbox environments require tokenId and tokenSecret.");
    }

    if (errors.length > 0) {
      return { ok: false, errors };
    }
    return { ok: true, normalizedConfig: { ...config } };
  },

  async onEnvironmentProbe(
    params: PluginEnvironmentProbeParams,
  ): Promise<PluginEnvironmentProbeResult> {
    const config = parseDriverConfig(params.config);
    const tags = buildSandboxTags({
      companyId: params.companyId,
      environmentId: params.environmentId,
      reuseLease: false,
    });
    const client = createModalClient(config);
    try {
      const app = await resolveApp(client, config);
      const sandbox = await createSandboxFor(client, app, config, tags);
      try {
        await ensureRemoteWorkspace(sandbox, config.workdir);
        const proc = await sandbox.exec(["sh", "-lc", "printf paperclip-probe"]);
        const { stdout, exitCode } = await readProcessStreams(proc);
        if (exitCode !== 0 || stdout.trim() !== "paperclip-probe") {
          return {
            ok: false,
            summary: `Modal sandbox probe failed: exit ${exitCode}, stdout=${JSON.stringify(stdout)}`,
            metadata: {
              provider: "modal",
              sandboxId: sandbox.sandboxId,
              appName: config.appName,
              image: config.image,
            },
          };
        }
        return {
          ok: true,
          summary: `Connected to Modal sandbox in app ${config.appName}.`,
          metadata: {
            provider: "modal",
            sandboxId: sandbox.sandboxId,
            appName: config.appName,
            image: config.image,
            workdir: config.workdir,
            sandboxTimeoutMs: config.sandboxTimeoutMs,
            idleTimeoutMs: config.idleTimeoutMs,
            reuseLease: config.reuseLease,
            remoteCwd: config.workdir,
          },
        };
      } finally {
        await sandbox.terminate().catch(() => undefined);
      }
    } catch (error) {
      return {
        ok: false,
        summary: "Modal sandbox probe failed.",
        metadata: {
          provider: "modal",
          appName: config.appName,
          image: config.image,
          reuseLease: config.reuseLease,
          error: formatErrorMessage(error),
        },
      };
    } finally {
      client.close();
    }
  },

  async onEnvironmentAcquireLease(
    params: PluginEnvironmentAcquireLeaseParams,
  ): Promise<PluginEnvironmentLease> {
    const config = parseDriverConfig(params.config);
    const client = createModalClient(config);
    try {
      const app = await resolveApp(client, config);
      const tags = buildSandboxTags({
        companyId: params.companyId,
        environmentId: params.environmentId,
        runId: params.runId,
        reuseLease: config.reuseLease,
      });
      const sandbox = await createSandboxFor(client, app, config, tags);
      try {
        await ensureRemoteWorkspace(sandbox, config.workdir);
        return {
          providerLeaseId: sandbox.sandboxId,
          metadata: leaseMetadata({
            config,
            sandbox,
            remoteCwd: config.workdir,
            resumedLease: false,
          }),
        };
      } catch (error) {
        await sandbox.terminate().catch(() => undefined);
        throw error;
      }
    } finally {
      // Keep the client open for the lease lifetime is unnecessary; subsequent
      // calls construct their own client. Close the local handle to free
      // grpc resources.
      client.close();
    }
  },

  async onEnvironmentResumeLease(
    params: PluginEnvironmentResumeLeaseParams,
  ): Promise<PluginEnvironmentLease> {
    const config = parseDriverConfig(params.config);
    const client = createModalClient(config);
    try {
      const sandbox = await getSandboxOrNull(client, params.providerLeaseId);
      if (!sandbox) {
        return { providerLeaseId: null, metadata: { expired: true } };
      }
      try {
        await ensureRemoteWorkspace(sandbox, config.workdir);
        return {
          providerLeaseId: sandbox.sandboxId,
          metadata: leaseMetadata({ config, sandbox, remoteCwd: config.workdir, resumedLease: true }),
        };
      } catch (error) {
        // If we just resumed and workspace setup blew up, treat as a lease
        // failure rather than silently terminating the user's reusable
        // sandbox. Detach so the sandbox is not killed for a transient setup
        // error.
        void sandbox.detach();
        throw error;
      }
    } finally {
      client.close();
    }
  },

  async onEnvironmentReleaseLease(
    params: PluginEnvironmentReleaseLeaseParams,
  ): Promise<void> {
    if (!params.providerLeaseId) return;
    const config = parseDriverConfig(params.config);
    const client = createModalClient(config);
    try {
      const sandbox = await getSandboxOrNull(client, params.providerLeaseId);
      if (!sandbox) return;
      if (config.reuseLease) {
        // Modal has no separate pause primitive. Detaching releases the local
        // grpc connection but leaves the sandbox running on Modal until its
        // configured sandboxTimeoutMs or idleTimeoutMs expires. The next
        // acquire/resume reconnects via sandboxes.fromId(providerLeaseId).
        void sandbox.detach();
        return;
      }
      await sandbox.terminate();
    } finally {
      client.close();
    }
  },

  async onEnvironmentDestroyLease(
    params: PluginEnvironmentDestroyLeaseParams,
  ): Promise<void> {
    if (!params.providerLeaseId) return;
    const config = parseDriverConfig(params.config);
    const client = createModalClient(config);
    try {
      const sandbox = await getSandboxOrNull(client, params.providerLeaseId);
      if (!sandbox) return;
      await sandbox.terminate();
    } finally {
      client.close();
    }
  },

  async onEnvironmentRealizeWorkspace(
    params: PluginEnvironmentRealizeWorkspaceParams,
  ): Promise<PluginEnvironmentRealizeWorkspaceResult> {
    const config = parseDriverConfig(params.config);
    const fallback =
      params.workspace.remotePath ??
      params.workspace.localPath ??
      config.workdir;
    const remoteCwd = leaseRemoteCwd(params.lease.metadata, fallback);
    if (params.lease.providerLeaseId) {
      const client = createModalClient(config);
      try {
        const sandbox = await getSandboxOrNull(client, params.lease.providerLeaseId);
        if (sandbox) {
          await ensureRemoteWorkspace(sandbox, remoteCwd);
        }
      } finally {
        client.close();
      }
    }
    return {
      cwd: remoteCwd,
      metadata: { provider: "modal", remoteCwd },
    };
  },

  async onEnvironmentExecute(
    params: PluginEnvironmentExecuteParams,
  ): Promise<PluginEnvironmentExecuteResult> {
    if (!params.lease.providerLeaseId) {
      return {
        exitCode: 1,
        timedOut: false,
        stdout: "",
        stderr: "No provider lease ID available for execution.",
      };
    }
    const config = parseDriverConfig(params.config);
    const client = createModalClient(config);
    const callerTimeoutMs =
      params.timeoutMs != null && Number.isFinite(params.timeoutMs) && params.timeoutMs > 0
        ? Math.max(1000, Math.trunc(params.timeoutMs / 1000) * 1000)
        : config.execTimeoutMs;

    try {
      const sandbox = await getSandboxOrNull(client, params.lease.providerLeaseId);
      if (!sandbox) {
        return {
          exitCode: 1,
          timedOut: false,
          stdout: "",
          stderr: "Modal sandbox lease is no longer available.\n",
        };
      }
      const stdinPath = params.stdin != null
        ? `/tmp/paperclip-stdin-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
        : null;
      try {
        if (stdinPath && params.stdin != null) {
          await stageStdin(sandbox, params.stdin, stdinPath);
        }
        const script = buildLoginShellScript({
          command: params.command,
          args: params.args ?? [],
          cwd: params.cwd ?? config.workdir,
          env: params.env,
          stdinPath: stdinPath ?? undefined,
        });
        const proc = await sandbox.exec(["sh", "-lc", script], {
          timeoutMs: callerTimeoutMs,
          stdout: "pipe",
          stderr: "pipe",
        });
        const { stdout, stderr, exitCode } = await readProcessStreams(proc);
        return {
          exitCode,
          timedOut: false,
          stdout,
          stderr,
        };
      } catch (error) {
        if (error instanceof TimeoutError || error instanceof SandboxTimeoutError) {
          return {
            exitCode: null,
            timedOut: true,
            stdout: "",
            stderr: `${formatErrorMessage(error)}\n`,
          };
        }
        throw error;
      } finally {
        if (stdinPath) {
          await deleteStdinPath(sandbox, stdinPath);
        }
      }
    } finally {
      client.close();
    }
  },
});

export default plugin;
