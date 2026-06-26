#!/usr/bin/env node
import { constants } from "node:fs";
import { access, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..");
const defaultPluginDir = path.resolve(
  repoRoot,
  "..",
  "..",
  "org",
  "paperclip-plugins",
  "keegoid-pi-github-pr-ingress",
);

function usage() {
  console.error(`Usage: github-pr-ingress-plugin-smoke.mjs [--plugin-dir PATH] [--keep-temp]

Runs the Keegoid GitHub PR ingress plugin smoke suite against this Paperclip checkout.

Options:
  --plugin-dir PATH  Source plugin directory. Defaults to KEEGOID_GITHUB_PR_INGRESS_PLUGIN_DIR
                     or ${defaultPluginDir}
  --keep-temp        Keep the staged plugin copy for debugging.
`);
}

function parseArgs(argv) {
  const options = {
    pluginDir: process.env.KEEGOID_GITHUB_PR_INGRESS_PLUGIN_DIR || defaultPluginDir,
    keepTemp: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      continue;
    } else if (arg === "--plugin-dir") {
      const value = argv[index + 1];
      if (!value) throw new Error("--plugin-dir requires a path");
      options.pluginDir = value;
      index += 1;
    } else if (arg === "--keep-temp") {
      options.keepTemp = true;
    } else if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return {
    ...options,
    pluginDir: path.resolve(options.pluginDir),
  };
}

async function assertReadableFile(filePath, label) {
  try {
    await access(filePath, constants.R_OK);
  } catch {
    throw new Error(`${label} not found or unreadable: ${filePath}`);
  }
}

async function run(command, args, options = {}) {
  console.log(`[github-pr-ingress-smoke] ${command} ${args.join(" ")}`);
  const result = await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repoRoot,
      env: options.env ?? process.env,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
  if (result.code !== 0) {
    const suffix = result.signal ? `signal ${result.signal}` : `exit ${result.code}`;
    throw new Error(`${command} ${args.join(" ")} failed with ${suffix}`);
  }
}

function copyFilter(source) {
  const name = path.basename(source);
  return name !== ".git" && name !== "node_modules" && name !== "dist" && name !== "coverage";
}

async function stagePlugin(pluginDir, stageRoot) {
  const stagedPluginDir = path.join(stageRoot, "plugin");
  await cp(pluginDir, stagedPluginDir, {
    recursive: true,
    filter: copyFilter,
  });

  await rm(path.join(stagedPluginDir, "pnpm-lock.yaml"), { force: true });

  const packageJsonPath = path.join(stagedPluginDir, "package.json");
  const pkg = JSON.parse(await readFile(packageJsonPath, "utf8"));
  pkg.dependencies = {
    ...pkg.dependencies,
    "@paperclipai/plugin-sdk": `link:${path.join(repoRoot, "packages", "plugins", "sdk")}`,
  };
  pkg.devDependencies = {
    ...pkg.devDependencies,
    "@paperclipai/shared": `link:${path.join(repoRoot, "packages", "shared")}`,
  };
  pkg.scripts = {
    ...pkg.scripts,
    prebuild: `pnpm --dir ${repoRoot} --filter @paperclipai/plugin-sdk ensure-build-deps`,
    typecheck: `pnpm --dir ${repoRoot} --filter @paperclipai/plugin-sdk ensure-build-deps && tsc --noEmit`,
  };
  await writeFile(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`);

  await writeFile(path.join(stagedPluginDir, "tests", "paperclip-ci-smoke.spec.ts"), smokeSpecSource());
  return stagedPluginDir;
}

function smokeSpecSource() {
  return `import { createHmac, randomUUID } from "node:crypto";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin, {
  ORIGIN_KIND,
  REVIEW_ORIGIN_KIND,
  WEBHOOK_KEY,
  routeReviewRequestForPullRequest,
  verifyGithubSignature,
} from "../src/worker.js";

const secretRef = "github-webhook-secret";
const resolvedSecret = \`resolved:\${secretRef}\`;
const repository = "keegoidllc/agentic-strategy-designer";
const fixtureRoot = path.join(process.cwd(), "paperclip smoke 'fixtures'");
const localRepoPath = path.join(fixtureRoot, "repos", "agentic-strategy-designer");
const agentPrFlowPath = path.join(fixtureRoot, "ops", "bin", "agent-pr-flow");

function shellQuote(value: string) {
  return "'" + value.replace(/'/g, "'\\\\''") + "'";
}

function expectedReviewCommand() {
  return [
    shellQuote(agentPrFlowPath),
    "review",
    "--repo",
    shellQuote(localRepoPath),
    "--pr",
    shellQuote("https://github.com/" + repository + "/pull/42"),
    "--author",
    shellQuote("codex"),
  ].join(" ");
}

function payload(action = "opened", overrides: Record<string, unknown> = {}) {
  return {
    action,
    repository: {
      full_name: repository,
      html_url: \`https://github.com/\${repository}\`,
    },
    pull_request: {
      number: 42,
      title: "Wire Paperclip PR ingress",
      html_url: \`https://github.com/\${repository}/pull/42\`,
      state: action === "closed" ? "closed" : "open",
      draft: false,
      merged: action === "closed",
      user: { login: "keegoid-codex" },
      head: {
        ref: "codex/github-pr-ingress",
        sha: action === "synchronize" ? "def456" : "abc123",
        repo: { full_name: repository },
      },
      base: {
        ref: "main",
        repo: { full_name: repository },
      },
    },
    ...overrides,
  };
}

function prListItem() {
  return {
    number: 42,
    title: "Wire Paperclip PR ingress",
    url: \`https://github.com/\${repository}/pull/42\`,
    author: { login: "keegoid-codex" },
    headRefName: "codex/github-pr-ingress",
    headRefOid: "def456",
    isDraft: false,
    reviews: [],
    files: [{ path: "paperclip-plugins/keegoid-pi-github-pr-ingress/src/worker.ts" }],
  };
}

function signature(rawBody: string, secret = resolvedSecret) {
  return \`sha256=\${createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")}\`;
}

function webhookInput(body: unknown, deliveryId: string = randomUUID(), secret = resolvedSecret) {
  const rawBody = JSON.stringify(body);
  return {
    endpointKey: WEBHOOK_KEY,
    requestId: \`req-\${deliveryId}\`,
    rawBody,
    parsedBody: body,
    headers: {
      "x-github-event": "pull_request",
      "x-github-delivery": deliveryId,
      "x-hub-signature-256": signature(rawBody, secret),
    },
  };
}

function harnessForRepo(companyId = randomUUID()) {
  return {
    companyId,
    harness: createTestHarness({
      manifest,
      capabilities: [...manifest.capabilities, "issue.comments.read"],
      config: {
        githubWebhookSecretRef: secretRef,
        repositories: [
          {
            repository,
            companyId,
            localRepoPath,
            priority: "high",
          },
        ],
      },
    }),
  };
}

describe("GitHub PR ingress Paperclip CI smoke", () => {
  it("verifies HMAC signatures before mutating issue state", async () => {
    const rawBody = JSON.stringify(payload());
    expect(verifyGithubSignature(rawBody, signature(rawBody), resolvedSecret)).toBe(true);
    expect(verifyGithubSignature(rawBody, signature(rawBody, "wrong"), resolvedSecret)).toBe(false);

    const { companyId, harness } = harnessForRepo();
    await plugin.definition.setup(harness.ctx);

    await expect(
      plugin.definition.onWebhook?.(webhookInput(payload(), "paperclip-ci-bad-signature", "wrong")),
    ).rejects.toThrow("Invalid GitHub webhook signature");

    await expect(harness.ctx.issues.list({ companyId, limit: 10, offset: 0 })).resolves.toHaveLength(0);
  });

  it("creates then updates one issue for opened, synchronize, and closed deliveries", async () => {
    const { companyId, harness } = harnessForRepo();
    await plugin.definition.setup(harness.ctx);

    await plugin.definition.onWebhook?.(webhookInput(payload("opened"), "paperclip-ci-opened"));
    await plugin.definition.onWebhook?.(webhookInput(payload("synchronize"), "paperclip-ci-synchronize"));
    await plugin.definition.onWebhook?.(webhookInput(payload("closed"), "paperclip-ci-closed"));

    const issues = await harness.ctx.issues.list({
      companyId,
      originKind: ORIGIN_KIND,
      originId: \`\${repository}#42\`,
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      title: \`[code-change] \${repository}#42: Wire Paperclip PR ingress\`,
      status: "done",
      priority: "high",
      billingCode: "github-pr-review",
    });
    expect(issues[0]?.description).toContain("Last webhook action: \`closed\`");

    const comments = await harness.ctx.issues.listComments(issues[0]!.id, companyId);
    expect(comments.map((comment) => comment.body)).toEqual([
      expect.stringContaining("GitHub PR webhook \`synchronize\` received"),
      expect.stringContaining("GitHub PR webhook \`closed\` received"),
    ]);
  });

  it("creates a review-start issue with the exact agent-pr-flow review command", async () => {
    const { companyId, harness } = harnessForRepo();
    await plugin.definition.setup(harness.ctx);
    await plugin.definition.onWebhook?.(webhookInput(payload("opened"), "paperclip-ci-review-parent"));

    const result = await routeReviewRequestForPullRequest(
      harness.ctx,
      {
        repository,
        companyId,
        assigneeAgentId: "dev-ceo-agent",
        localRepoPath,
        priority: "high",
      },
      {
        reviewRoutingEnabled: true,
        agentPrFlowPath,
      },
      prListItem(),
    );

    expect(result).toMatchObject({ action: "created" });
    const issues = await harness.ctx.issues.list({
      companyId,
      originKind: REVIEW_ORIGIN_KIND,
      originId: \`\${repository}#42@def456:keegoid-cc\`,
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.description).toContain(expectedReviewCommand());
  });
});
`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await assertReadableFile(path.join(options.pluginDir, "package.json"), "Plugin package.json");
  await assertReadableFile(path.join(options.pluginDir, "src", "worker.ts"), "Plugin worker");
  await assertReadableFile(path.join(options.pluginDir, "src", "manifest.ts"), "Plugin manifest");

  const stageRoot = await mkdtemp(path.join(tmpdir(), "paperclip-github-pr-ingress-smoke-"));
  console.log(`[github-pr-ingress-smoke] staging plugin from ${options.pluginDir}`);
  console.log(`[github-pr-ingress-smoke] temp dir ${stageRoot}`);
  try {
    const stagedPluginDir = await stagePlugin(options.pluginDir, stageRoot);
    await run("pnpm", ["--filter", "@paperclipai/plugin-sdk", "build"], { cwd: repoRoot });
    await run("pnpm", ["install", "--ignore-scripts", "--no-frozen-lockfile"], { cwd: stagedPluginDir });
    await run("pnpm", ["exec", "vitest", "run", "--config", "vitest.config.ts", "tests/paperclip-ci-smoke.spec.ts"], {
      cwd: stagedPluginDir,
    });
  } finally {
    if (options.keepTemp) {
      console.log(`[github-pr-ingress-smoke] kept temp dir ${stageRoot}`);
    } else {
      await rm(stageRoot, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  console.error(`[github-pr-ingress-smoke] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
