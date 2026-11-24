import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineConfig } from "@playwright/test";

// Use a dedicated port so e2e tests always start their own server in local_trusted mode,
// even when the dev server is running on :3100 in authenticated mode.
const PORT = Number(process.env.PAPERCLIP_E2E_PORT ?? 3199);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const PAPERCLIP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-e2e-home-"));
const PAPERCLIP_INSTANCE_ID = "playwright-e2e";
const PAPERCLIP_CONFIG = path.join(PAPERCLIP_HOME, "instances", PAPERCLIP_INSTANCE_ID, "config.json");
const PAPERCLIP_AGENT_JWT_SECRET = process.env.PAPERCLIP_AGENT_JWT_SECRET ?? "playwright-e2e-agent-jwt-secret";
const PAPERCLIP_DECISION_SIGNING_SECRET =
  process.env.PAPERCLIP_DECISION_SIGNING_SECRET ?? "playwright-e2e-decision-signing-secret";
const PAPERCLIP_TOOL_ACTION_SIGNING_SECRET =
  process.env.PAPERCLIP_TOOL_ACTION_SIGNING_SECRET ?? "playwright-e2e-tool-action-signing-secret";
const PLAYWRIGHT_CHANNEL = process.env.PAPERCLIP_PLAYWRIGHT_CHANNEL;

process.env.PAPERCLIP_HOME = PAPERCLIP_HOME;
process.env.PAPERCLIP_CONFIG = PAPERCLIP_CONFIG;
// Worker processes reload this config; retain the main process's server path
// for specs that seed historical database state in the throwaway instance.
process.env.PAPERCLIP_E2E_SERVER_CONFIG ??= PAPERCLIP_CONFIG;
// Specs that mint agent JWTs in-process (via createLocalAgentJwt) must derive
// the same per-instance signing key as the webServer, or verification fails
// with a 401 instead of authenticating as the agent.
process.env.PAPERCLIP_INSTANCE_ID = PAPERCLIP_INSTANCE_ID;
process.env.PAPERCLIP_AGENT_JWT_SECRET = PAPERCLIP_AGENT_JWT_SECRET;
process.env.PAPERCLIP_DECISION_SIGNING_SECRET = PAPERCLIP_DECISION_SIGNING_SECRET;
process.env.PAPERCLIP_TOOL_ACTION_SIGNING_SECRET = PAPERCLIP_TOOL_ACTION_SIGNING_SECRET;

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const UI_DIST_INDEX = path.join(REPO_ROOT, "server", "ui-dist", "index.html");
const SKIP_UI_BUILD = ["1", "true"].includes(
  (process.env.PAPERCLIP_E2E_SKIP_UI_BUILD ?? "").trim().toLowerCase(),
);
if (SKIP_UI_BUILD && !fs.existsSync(UI_DIST_INDEX)) {
  throw new Error(
    `PAPERCLIP_E2E_SKIP_UI_BUILD is enabled, but prebuilt UI assets are missing at ${UI_DIST_INDEX}. ` +
      "Build @paperclipai/ui into server/ui-dist first or unset PAPERCLIP_E2E_SKIP_UI_BUILD.",
  );
}

// Specs that mutate instance-wide state on the shared throwaway server
// (server-read experimental flags or server-persisted workspace preferences)
// or assert strict real-time latency / focus restoration sensitive to
// multi-worker Chromium CPU contention. Keep in sync with `SERIAL_SPECS` in
// `scripts/e2e-shard.mjs` — `scripts/__tests__/e2e-shard.test.mjs` fails if
// the two ever drift.
export const SERIAL_SPECS = [
  "agent-configuration.spec.ts",
  "cases-read-only.spec.ts",
  "classic-workspace.spec.ts",
  "composer-stop.spec.ts",
  "connection-intents.spec.ts",
  "document-image-gallery.spec.ts",
  "onboarding.spec.ts",
  "smoke-lab-p1-p4.spec.ts",
  "smoke-lab-p5-p7.spec.ts",
];

function extractCliSpecBasenames(argv: string[]): string[] {
  const specs: string[] = [];
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--config" || arg === "-c" || arg === "--project" || arg === "--grep" || arg === "-g") {
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) continue;
    if (arg.endsWith(".spec.ts")) {
      specs.push(path.basename(arg));
    }
  }
  return specs;
}

function resolveExecutionMode(): { workers: number; fullyParallel: boolean } {
  // Worker processes reload this config without the parent CLI spec filters.
  // Cache the parent process's decision in env so workers agree with the runner.
  if (
    process.env.PAPERCLIP_E2E_RESOLVED_WORKERS &&
    process.env.PAPERCLIP_E2E_RESOLVED_FULLY_PARALLEL
  ) {
    return {
      workers: Number(process.env.PAPERCLIP_E2E_RESOLVED_WORKERS),
      fullyParallel: process.env.PAPERCLIP_E2E_RESOLVED_FULLY_PARALLEL === "true",
    };
  }

  const cliSpecs = extractCliSpecBasenames(process.argv);
  const serialSet = new Set(SERIAL_SPECS);
  const includesSerial = cliSpecs.some((spec) => serialSet.has(spec));
  const strictlyParallelSafe = cliSpecs.length > 0 && !includesSerial;

  const explicitWorkers = Number.parseInt(process.env.PAPERCLIP_E2E_WORKERS ?? "", 10);
  let workers: number;
  let fullyParallel: boolean;
  if (Number.isInteger(explicitWorkers) && explicitWorkers >= 1) {
    workers = explicitWorkers;
    fullyParallel = workers > 1 && !includesSerial;
  } else if (strictlyParallelSafe) {
    // 2 Chromium workers + Node server + embedded Postgres fits cleanly on
    // 4-vCPU CI runners without CPU over-subscription thrashing.
    workers = process.env.CI
      ? 2
      : Math.min(2, Math.max(1, Math.floor(os.cpus().length / 2)));
    fullyParallel = true;
  } else {
    workers = 1;
    fullyParallel = false;
  }

  process.env.PAPERCLIP_E2E_RESOLVED_WORKERS = String(workers);
  process.env.PAPERCLIP_E2E_RESOLVED_FULLY_PARALLEL = String(fullyParallel);
  return { workers, fullyParallel };
}

const EXECUTION_MODE = resolveExecutionMode();
const SERVER_START_COMMAND =
  "node cli/node_modules/tsx/dist/cli.mjs cli/src/index.ts onboard --yes --run";
const WEB_SERVER_COMMAND = SKIP_UI_BUILD
  ? SERVER_START_COMMAND
  : `pnpm --filter @paperclipai/ui build --outDir ../server/ui-dist --emptyOutDir && ${SERVER_START_COMMAND}`;

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  // These suites target dedicated multi-user configurations/ports and are
  // intentionally not part of the default local_trusted e2e run.
  testIgnore: ["in-feed-native/**", "multi-user.spec.ts", "multi-user-authenticated.spec.ts"],
  timeout: 60_000,
  retries: 0,
  // Parallel-safe shards run concurrently across multiple workers; shards or
  // runs that include any spec in SERIAL_SPECS (or unfiltered full runs) fall
  // back to 1 worker so server-level experimental flags cannot race mid-flight.
  workers: EXECUTION_MODE.workers,
  fullyParallel: EXECUTION_MODE.fullyParallel,
  use: {
    baseURL: BASE_URL,
    headless: true,
    screenshot: "only-on-failure",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: {
        browserName: "chromium",
        ...(PLAYWRIGHT_CHANNEL ? { channel: PLAYWRIGHT_CHANNEL } : {}),
      },
    },
  ],
  // The webServer directive bootstraps a throwaway instance and then starts it.
  // `onboard --yes --run` works in a non-interactive temp PAPERCLIP_HOME.
  webServer: {
    cwd: REPO_ROOT,
    // Exercise the shipped UI. Source-checkout onboarding otherwise enables
    // Vite middleware: every reload traverses thousands of modules, including
    // service-worker-intercepted requests, before React can even start.
    // Build the server's first-choice static directory unless CI/caller already
    // prebuilt server/ui-dist and opted in via PAPERCLIP_E2E_SKIP_UI_BUILD=1.
    command: WEB_SERVER_COMMAND,
    url: `${BASE_URL}/api/health`,
    // Always boot a dedicated throwaway instance for e2e so browser tests
    // never attach to the developer's active Paperclip home/server.
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      NODE_ENV: "test",
      PAPERCLIP_UI_DEV_MIDDLEWARE: "false",
      HEARTBEAT_SCHEDULER_INTERVAL_MS: process.env.HEARTBEAT_SCHEDULER_INTERVAL_MS ?? "10000",
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${path.resolve(import.meta.dirname, "fixtures/agent-chat-github.mjs")} --import=${path.resolve(import.meta.dirname, "fixtures/ai-connection-provider.mjs")}`,
      PORT: String(PORT),
      PAPERCLIP_OPEN_ON_LISTEN: "false",
      PAPERCLIP_API_URL: BASE_URL,
      PAPERCLIP_HOME,
      PAPERCLIP_INSTANCE_ID,
      PAPERCLIP_CONFIG,
      PAPERCLIP_AGENT_JWT_SECRET,
      PAPERCLIP_DECISION_SIGNING_SECRET,
      PAPERCLIP_TOOL_ACTION_SIGNING_SECRET,
      PAPERCLIP_BIND: "loopback",
      PAPERCLIP_DEPLOYMENT_MODE: "local_trusted",
      PAPERCLIP_DEPLOYMENT_EXPOSURE: "private",
    },
  },
  outputDir: "./test-results",
  reporter: [
    ["list"], ["html", { open: "never", outputFolder: "./playwright-report" }],
    ...(process.env.GITHUB_ACTIONS === "true"
      ? [[path.resolve(import.meta.dirname, "../../scripts/ci/oversized-test-files-playwright.mjs")] as [string]]
      : []),
    ...(process.env.PAPERCLIP_CI_PROFILE === "true"
      ? [[path.resolve(import.meta.dirname, "../../scripts/ci-profile/playwright-reporter.mjs")] as [string]]
      : []),
  ],
});
