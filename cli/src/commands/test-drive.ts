import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { Option, type Command } from "commander";
import type { Agent, Company, InstanceExperimentalSettings } from "@paperclipai/shared";
import { PaperclipApiClient } from "../client/http.js";
import { openUrl } from "../client/board-auth.js";
import {
  expandHomePrefix,
  resolveDefaultConfigPath,
  resolveDefaultContextPath,
} from "../config/home.js";
import { readConfig } from "../config/store.js";
import type { PaperclipConfig } from "../config/schema.js";
import { runCommand, type StartedServer } from "./run.js";
import { isLinkedGitWorktree } from "./git-workspace.js";

export const TEST_DRIVE_HARNESSES = ["claude", "codex", "opencode"] as const;
export type TestDriveHarness = (typeof TEST_DRIVE_HARNESSES)[number];

export interface TestDriveOptions {
  dataDir?: string;
  companyName?: string;
  agentName?: string;
  harness?: TestDriveHarness;
  model?: string;
  apiKeyEnv?: string;
  apiKey?: string;
  browser?: boolean;
}

export type TestDriveApi = Pick<PaperclipApiClient, "get" | "post" | "patch" | "delete">;

type HarnessDefinition = {
  adapterType: "claude_local" | "codex_local" | "opencode_local";
  credentialTarget: "ANTHROPIC_API_KEY" | "OPENAI_API_KEY" | "OPENROUTER_API_KEY";
  credentialName: string;
};

export type ResolvedTestDriveBootstrap = HarnessDefinition & {
  companyName: string;
  agentName: string;
  model?: string;
  credential: string;
  credentialSource: string;
};

export type TestDriveBootstrapResult = {
  reused: boolean;
  company: Company;
  agent: Agent | null;
};

export interface TestDriveDependencies {
  run: typeof runCommand;
  createApi: (apiBase: string) => TestDriveApi;
  openBrowser: (url: string) => Promise<boolean>;
}

const HARNESS_DEFINITIONS: Record<TestDriveHarness, HarnessDefinition> = {
  claude: {
    adapterType: "claude_local",
    credentialTarget: "ANTHROPIC_API_KEY",
    credentialName: "Anthropic API Key",
  },
  codex: {
    adapterType: "codex_local",
    credentialTarget: "OPENAI_API_KEY",
    credentialName: "OpenAI API Key",
  },
  opencode: {
    adapterType: "opencode_local",
    credentialTarget: "OPENROUTER_API_KEY",
    credentialName: "OpenRouter API Key",
  },
};

const NON_PAPERCLIP_ISOLATED_ENV_KEYS = [
  "DATABASE_URL",
  "DATABASE_MIGRATION_URL",
  "HOST",
  "PORT",
  "SERVE_UI",
  "BETTER_AUTH_URL",
  "BETTER_AUTH_BASE_URL",
] as const;

function requiredApiResult<T>(value: T | null, action: string): T {
  if (value === null) {
    throw new Error(`Paperclip returned no result while ${action}.`);
  }
  return value;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export function redactTestDriveText(text: string, credentials: Array<string | undefined>): string {
  let redacted = text;
  for (const credential of credentials) {
    if (!credential) continue;
    redacted = redacted.replaceAll(credential, "[REDACTED]");
  }
  return redacted;
}

export function redactTestDriveArgv(
  apiKey: string | undefined,
  argv: string[] = process.argv,
): void {
  if (!apiKey) return;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--api-key" && argv[index + 1] === apiKey) {
      argv[index + 1] = "[REDACTED]";
      index += 1;
      continue;
    }
    if (argv[index] === `--api-key=${apiKey}`) {
      argv[index] = "--api-key=[REDACTED]";
    }
  }
}

export function resolveTestDriveDataDir(dataDir?: string): string {
  const explicit = dataDir?.trim();
  if (explicit) {
    return path.resolve(expandHomePrefix(explicit));
  }
  return fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-test-drive-"));
}

async function loopbackPortAvailable(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const server = createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

export async function resolveTestDriveServerPort(preferredPort = 3100): Promise<number> {
  for (let port = preferredPort; port <= 65_535; port += 1) {
    if (await loopbackPortAvailable(port)) return port;
  }
  throw new Error(`No available loopback port found at or above ${preferredPort}.`);
}

/**
 * Establish isolation before the CLI's normal config and .env loading hook.
 * The selected credential source is preserved in case its name happens to use
 * a PAPERCLIP_ prefix; all other Paperclip routing/configuration is discarded.
 */
export async function prepareTestDriveEnvironment(
  options: Pick<TestDriveOptions, "dataDir" | "apiKeyEnv">,
  cwd = process.cwd(),
): Promise<{ dataDir: string; linkedWorktree: boolean }> {
  const sourceEnvName = options.apiKeyEnv?.trim();
  const preservedCredential = sourceEnvName ? process.env[sourceEnvName] : undefined;

  for (const key of Object.keys(process.env)) {
    if (key.startsWith("PAPERCLIP_")) {
      delete process.env[key];
    }
  }
  for (const key of NON_PAPERCLIP_ISOLATED_ENV_KEYS) {
    delete process.env[key];
  }
  if (sourceEnvName && preservedCredential !== undefined) {
    process.env[sourceEnvName] = preservedCredential;
  }

  const dataDir = resolveTestDriveDataDir(options.dataDir);
  const linkedWorktree = isLinkedGitWorktree(cwd);
  process.env.PAPERCLIP_HOME = dataDir;
  process.env.PAPERCLIP_INSTANCE_ID = "default";
  process.env.PAPERCLIP_CONFIG = resolveDefaultConfigPath("default");
  process.env.PAPERCLIP_CONTEXT = resolveDefaultContextPath();
  process.env.PAPERCLIP_IN_WORKTREE = linkedWorktree ? "true" : "false";
  process.env.PAPERCLIP_OPEN_ON_LISTEN = "false";
  process.env.PAPERCLIP_DISABLE_CWD_ENV_FILE = "true";
  process.env.PAPERCLIP_DEPLOYMENT_MODE = "local_trusted";
  process.env.PAPERCLIP_DEPLOYMENT_EXPOSURE = "private";
  process.env.PAPERCLIP_BIND = "loopback";
  process.env.HOST = "127.0.0.1";
  process.env.PORT = String(await resolveTestDriveServerPort());

  return { dataDir, linkedWorktree };
}

export function assertTestDriveDatabaseIsolation(
  configPath?: string,
  env: NodeJS.ProcessEnv = process.env,
  readConfigFile: (path?: string) => PaperclipConfig | null = readConfig,
): void {
  if (env.DATABASE_URL?.trim() || env.DATABASE_MIGRATION_URL?.trim()) {
    throw new Error(
      "test-drive requires its isolated embedded database. Remove DATABASE_URL and " +
        "DATABASE_MIGRATION_URL from the selected data directory's .env, or choose a fresh --data-dir.",
    );
  }

  const config = readConfigFile(configPath);
  if (config?.database.mode === "postgres") {
    throw new Error(
      "test-drive cannot reuse a data directory configured for an external PostgreSQL database. " +
        "Choose a fresh data directory or change database.mode to embedded-postgres.",
    );
  }
}

export function resolveTestDriveBootstrap(
  options: TestDriveOptions,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedTestDriveBootstrap {
  if (options.apiKey !== undefined && options.apiKeyEnv !== undefined) {
    throw new Error("--api-key and --api-key-env are mutually exclusive.");
  }

  const harness = options.harness ?? "claude";
  const definition = HARNESS_DEFINITIONS[harness];
  if (!definition) {
    throw new Error(`Unsupported test-drive harness: ${String(harness)}.`);
  }

  const companyName = (options.companyName ?? "Test Company").trim();
  const agentName = (options.agentName ?? "CEO").trim();
  if (!companyName) throw new Error("--company-name cannot be empty.");
  if (!agentName) throw new Error("--agent-name cannot be empty.");

  const model = options.model;
  if (model !== undefined && (!model || model.trim() !== model)) {
    throw new Error("--model cannot be empty or have surrounding whitespace.");
  }
  if (
    harness === "opencode" &&
    (!model || !/^openrouter\/[^/\s]+(?:\/[^/\s]+)*$/.test(model))
  ) {
    throw new Error(
      "OpenCode test drives require --model openrouter/<model>, with no empty path segments.",
    );
  }

  const sourceEnvName = options.apiKeyEnv?.trim() || definition.credentialTarget;
  if (options.apiKeyEnv !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(sourceEnvName)) {
    throw new Error("--api-key-env must name a valid environment variable.");
  }
  const credential = options.apiKey ?? env[sourceEnvName];
  if (!credential || credential.trim().length === 0) {
    throw new Error(
      `No credential found. Set ${sourceEnvName}, pass --api-key-env <variable>, or pass --api-key <value>.`,
    );
  }

  return {
    ...definition,
    companyName,
    agentName,
    ...(model ? { model } : {}),
    credential,
    credentialSource: options.apiKey !== undefined ? "--api-key" : sourceEnvName,
  };
}

function worktreeExecutionArmed(
  settings: InstanceExperimentalSettings,
  instanceId: string,
): boolean {
  return settings.enableWorktreeRunExecution === true
    && Boolean(settings.worktreeRunExecutionActivatedAt)
    && settings.worktreeRunExecutionActivationInstanceId === instanceId;
}

export async function reconcileTestDriveWorktreeExecution(
  api: TestDriveApi,
  instanceId: string,
): Promise<void> {
  const current = requiredApiResult(
    await api.get<InstanceExperimentalSettings>("/api/instance/settings/experimental"),
    "reading experimental settings",
  );

  if (!current.enableWorktreeRunExecution) {
    await api.patch<InstanceExperimentalSettings>("/api/instance/settings/experimental", {
      enableWorktreeRunExecution: true,
    });
  } else if (!worktreeExecutionArmed(current, instanceId)) {
    await api.patch<InstanceExperimentalSettings>("/api/instance/settings/experimental", {
      enableWorktreeRunExecution: false,
    });
    await api.patch<InstanceExperimentalSettings>("/api/instance/settings/experimental", {
      enableWorktreeRunExecution: true,
    });
  }

  const verified = requiredApiResult(
    await api.get<InstanceExperimentalSettings>("/api/instance/settings/experimental"),
    "verifying experimental settings",
  );
  if (!worktreeExecutionArmed(verified, instanceId)) {
    throw new Error(
      `Could not arm “Run tasks in this worktree” for Paperclip instance ${instanceId}. ` +
        "Check that PAPERCLIP_IN_WORKTREE=true and retry the command.",
    );
  }
}

export async function bootstrapTestDrive(input: {
  api: TestDriveApi;
  options: TestDriveOptions;
  linkedWorktree: boolean;
  instanceId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<TestDriveBootstrapResult> {
  const companies = requiredApiResult(
    await input.api.get<Company[]>("/api/companies"),
    "reading companies",
  );
  const existingCompany = companies[0];
  if (existingCompany) {
    if (input.linkedWorktree) {
      await reconcileTestDriveWorktreeExecution(input.api, input.instanceId);
    }
    return { reused: true, company: existingCompany, agent: null };
  }

  // Resolve every bootstrap input before the first mutation. In particular,
  // OpenCode model validation and credential lookup happen before company
  // creation so an invalid invocation leaves the database untouched.
  const resolved = resolveTestDriveBootstrap(input.options, input.env);
  let company: Company | null = null;
  try {
    company = requiredApiResult(
      await input.api.post<Company>("/api/companies", { name: resolved.companyName }),
      "creating the test company",
    );
    await input.api.post(`/api/companies/${company.id}/user-secret-definitions`, {
      key: resolved.credentialTarget,
      name: resolved.credentialName,
    });
    await input.api.post(`/api/companies/${company.id}/me/user-secrets`, {
      definitionKey: resolved.credentialTarget,
      value: resolved.credential,
    });

    const adapterConfig: Record<string, unknown> = {
      env: {
        [resolved.credentialTarget]: {
          type: "user_secret_ref",
          key: resolved.credentialTarget,
          version: "latest",
          required: true,
        },
      },
    };
    if (resolved.model) adapterConfig.model = resolved.model;

    const agent = requiredApiResult(
      await input.api.post<Agent>(`/api/companies/${company.id}/agents`, {
        name: resolved.agentName,
        role: "ceo",
        adapterType: resolved.adapterType,
        adapterConfig,
      }),
      "creating the CEO agent",
    );

    if (input.linkedWorktree) {
      await reconcileTestDriveWorktreeExecution(input.api, input.instanceId);
    }
    return { reused: false, company, agent };
  } catch (error) {
    if (company) {
      try {
        await input.api.delete(`/api/companies/${company.id}`);
      } catch (cleanupError) {
        throw new Error(
          `${errorMessage(error)} Cleanup also failed for newly-created company ${company.id}: ${errorMessage(cleanupError)}`,
          { cause: error },
        );
      }
    }
    throw error;
  }
}

function dashboardUrl(server: StartedServer): string {
  return server.apiUrl.replace(/\/api\/?$/, "");
}

export async function testDriveCommand(
  options: TestDriveOptions,
  dependencies: TestDriveDependencies = {
    run: runCommand,
    createApi: (apiBase) => new PaperclipApiClient({ apiBase }),
    openBrowser: openUrl,
  },
): Promise<void> {
  // Commander has already copied the value into options. Remove it from the
  // JavaScript argv view before logging, telemetry, diagnostics, or startup.
  redactTestDriveArgv(options.apiKey);
  const dataDir = path.resolve(process.env.PAPERCLIP_HOME ?? resolveTestDriveDataDir(options.dataDir));
  const linkedWorktree = process.env.PAPERCLIP_IN_WORKTREE === "true";
  const instanceId = process.env.PAPERCLIP_INSTANCE_ID ?? "default";
  // Resolve environment-backed credentials against the CLI environment as it
  // exists before server startup. In-process server initialization must not
  // change which credential the post-listen bootstrap observes.
  const bootstrapEnv = { ...process.env };
  const possibleCredentials = [
    options.apiKey,
    options.apiKeyEnv ? bootstrapEnv[options.apiKeyEnv.trim()] : undefined,
    bootstrapEnv[HARNESS_DEFINITIONS[options.harness ?? "claude"].credentialTarget],
  ];

  p.log.message(pc.dim(`Data directory: ${dataDir}`));
  p.log.message(pc.dim("The data directory is retained when Paperclip exits."));
  if (options.apiKey !== undefined) {
    p.log.warn("A key passed with --api-key may be visible in process arguments and shell history.");
  }

  try {
    await dependencies.run({
      repair: true,
      yes: true,
      bind: "loopback",
      installService: false,
      // Auto-created directories are private to this process. Explicitly reused
      // directories retain the normal guard against an already-managed instance.
      skipServiceManagerCheck: !options.dataDir?.trim(),
      introLabel: "paperclipai test-drive",
      afterStart: async (server) => {
        const api = dependencies.createApi(server.apiUrl);
        const result = await bootstrapTestDrive({
          api,
          options,
          linkedWorktree,
          instanceId,
          env: bootstrapEnv,
        });
        if (result.reused) {
          p.log.message(
            `Using existing data for ${pc.cyan(result.company.name)}; bootstrap flags were ignored.`,
          );
        } else {
          p.log.success(
            `Created ${pc.cyan(result.company.name)} with agent ${pc.cyan(result.agent?.name ?? "CEO")}.`,
          );
        }
        if (linkedWorktree) {
          p.log.success("Run tasks in this worktree is enabled for this instance.");
        }

        const url = dashboardUrl(server);
        if (options.browser === false) {
          p.log.success(`Paperclip is ready at ${pc.cyan(url)}.`);
          return;
        }
        const opened = await dependencies.openBrowser(url);
        if (opened) {
          p.log.success(`Paperclip is ready and opened at ${pc.cyan(url)}.`);
        } else {
          p.log.warn(`Paperclip is ready, but the browser could not be opened. Visit ${url}.`);
        }
      },
    });
  } catch (error) {
    throw new Error(redactTestDriveText(errorMessage(error), possibleCredentials), { cause: error });
  }
}

export function registerTestDriveCommand(program: Command): void {
  program
    .command("test-drive")
    .description("Start an isolated, initialized Paperclip instance for manual testing")
    .option("-d, --data-dir <path>", "Paperclip data directory to create or reuse")
    .option("--company-name <name>", "Initial company name", "Test Company")
    .option("--agent-name <name>", "Initial CEO agent name", "CEO")
    .addOption(
      new Option("--harness <harness>", "Initial agent harness")
        .choices(TEST_DRIVE_HARNESSES)
        .default("claude"),
    )
    .option("--model <model-id>", "Initial agent model")
    .addOption(
      new Option("--api-key-env <variable>", "Read the provider key from an environment variable")
        .conflicts("apiKey"),
    )
    .addOption(
      new Option("--api-key <value>", "Provider API key")
        .conflicts("apiKeyEnv"),
    )
    .option("--no-browser", "Do not open the initialized instance in a browser")
    .action(async (options: TestDriveOptions) => {
      await testDriveCommand(options);
    });
}
