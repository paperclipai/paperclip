import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

const expectedCacheEnv = {
  XDG_CACHE_HOME: "/runtime-cache/xdg",
  GOCACHE: "/runtime-cache/go-build",
  GOMODCACHE: "/runtime-cache/gomod",
  npm_config_cache: "/runtime-cache/npm",
  BUN_INSTALL_CACHE: "/runtime-cache/bun",
  PIP_CACHE_DIR: "/runtime-cache/pip",
  PLAYWRIGHT_BROWSERS_PATH: "/runtime-cache/ms-playwright",
};

function renderStatefulSet(extraArgs = []) {
  return execFileSync(
    "helm",
    [
      "template",
      "paperclip",
      "deploy/helm/paperclip",
      "--namespace",
      "paperclip",
      "-f",
      "deploy/helm/paperclip/values.blockcast.yaml",
      "--show-only",
      "templates/statefulset.yaml",
      ...extraArgs,
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
}

function renderApiDeployment(extraArgs = []) {
  return execFileSync(
    "helm",
    [
      "template",
      "paperclip",
      "deploy/helm/paperclip",
      "--namespace",
      "paperclip",
      "-f",
      "deploy/helm/paperclip/values.blockcast.yaml",
      "--show-only",
      "templates/deployment-api.yaml",
      "--set",
      "api.enabled=true",
      ...extraArgs,
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function countMatches(value, pattern) {
  return Array.from(value.matchAll(pattern)).length;
}

function extractEnvBlock(rendered, envName) {
  const lines = rendered.split("\n");
  const namePattern = new RegExp(`^(\\s*)- name: ${escapeRegExp(envName)}$`);

  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(namePattern);
    if (!match) continue;

    const indentLength = match[1].length;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j += 1) {
      const nextEnv = lines[j].match(/^(\s*)- name: /);
      if (nextEnv && nextEnv[1].length <= indentLength) {
        end = j;
        break;
      }
    }
    return `${lines.slice(i, end).join("\n")}\n`;
  }

  assert.fail(`${envName} should render`);
}

function assertValueEnv(rendered, envName, value) {
  assert.match(
    extractEnvBlock(rendered, envName),
    new RegExp(`\\n\\s+value: ["']?${escapeRegExp(value)}["']?\\n`),
    `${envName} should render as ${value}`,
  );
}

function extractValueEnv(rendered, envName) {
  const envBlock = extractEnvBlock(rendered, envName);
  const match = envBlock.match(/\n\s+value: (.+)\n/);
  assert.ok(match?.[1], `${envName} should render a literal value`);

  const rawValue = match[1].trim();
  if (
    (rawValue.startsWith('"') && rawValue.endsWith('"')) ||
    (rawValue.startsWith("'") && rawValue.endsWith("'"))
  ) {
    return rawValue.slice(1, -1);
  }
  return rawValue;
}

function assertPenstockOrgKeySecretEnv(rendered, envName) {
  const envBlock = extractEnvBlock(rendered, envName);

  assert.match(envBlock, /\n\s+valueFrom:\n/, `${envName} should use valueFrom`);
  assert.match(envBlock, /\n\s+secretKeyRef:\n/, `${envName} should use secretKeyRef`);
  assert.match(
    envBlock,
    /\n\s+name: paperclip-penstock-org-key\n/,
    `${envName} should inherit the Penstock org key secret`,
  );
  assert.match(envBlock, /\n\s+key: token\n/, `${envName} should read the token key`);
  assert.match(
    envBlock,
    /\n\s+optional: true\n/,
    `${envName} should not block pod startup when the Penstock org key is absent`,
  );
}

function assertNoLegacyProviderSecretEnv(rendered, envName) {
  const envBlock = extractEnvBlock(rendered, envName);

  assert.doesNotMatch(
    envBlock,
    /paperclip-ccrotate-serve-secrets|paperclip-ccrotate-board-token/,
    `${envName} should not inherit a legacy ccrotate secret`,
  );
}

function assertCodexPenstockProvider(rendered) {
  const value = extractValueEnv(rendered, "PAPERCLIP_CODEX_PROVIDERS");
  const parsed = JSON.parse(value);

  assert.equal(parsed.model_provider, "penstock");
  assert.deepEqual(Object.keys(parsed.providers ?? {}), ["penstock"]);
  assert.deepEqual(parsed.providers?.penstock, {
    name: "Penstock OpenAI gateway",
    base_url: "https://api.penstock.run/v1",
    env_key: "OPENAI_API_KEY",
    wire_api: "responses",
  });
}

test("runtimeCache mounts emptyDir and redirects regenerable caches", () => {
  const rendered = renderStatefulSet();

  for (const [name, value] of Object.entries(expectedCacheEnv)) {
    const pattern = new RegExp(
      `- name: ${escapeRegExp(name)}\\n\\s+value: "${escapeRegExp(value)}"`,
      "g",
    );
    assert.equal(
      countMatches(rendered, pattern),
      2,
      `${name} should render for the seed init container and the paperclip container`,
    );
  }

  assert.equal(
    countMatches(rendered, /- name: runtime-cache\n\s+mountPath: "\/runtime-cache"/g),
    2,
    "runtime-cache should mount into the seed init container and the paperclip container",
  );
  assert.match(
    rendered,
    /- name: runtime-cache\n\s+emptyDir:\n\s+sizeLimit: "20Gi"/,
    "runtime-cache volume should render as a size-limited emptyDir",
  );
});

test("runtimeCache can be disabled for rollback", () => {
  const rendered = renderStatefulSet(["--set", "runtimeCache.enabled=false"]);

  assert.doesNotMatch(rendered, /name: runtime-cache/);
  assert.doesNotMatch(rendered, /mountPath: "\/runtime-cache"/);
  assert.doesNotMatch(rendered, /\/runtime-cache\//);
  assert.doesNotMatch(rendered, /XDG_CACHE_HOME/);
});

test("runtimeCache redirects API tier caches when HA mode is enabled", () => {
  const rendered = renderApiDeployment();

  for (const [name, value] of Object.entries(expectedCacheEnv)) {
    const pattern = new RegExp(
      `- name: ${escapeRegExp(name)}\\n\\s+value: "${escapeRegExp(value)}"`,
      "g",
    );
    assert.equal(
      countMatches(rendered, pattern),
      1,
      `${name} should render for the API deployment container`,
    );
  }

  assert.equal(
    countMatches(rendered, /- name: runtime-cache\n\s+mountPath: "\/runtime-cache"/g),
    1,
    "runtime-cache should mount into the API deployment container",
  );
  assert.match(
    rendered,
    /- name: runtime-cache\n\s+emptyDir:\n\s+sizeLimit: "20Gi"/,
    "API deployment runtime-cache volume should render as a size-limited emptyDir",
  );
});

test("runtimeCache can be disabled for API tier rollback", () => {
  const rendered = renderApiDeployment(["--set", "runtimeCache.enabled=false"]);

  assert.doesNotMatch(rendered, /name: runtime-cache/);
  assert.doesNotMatch(rendered, /mountPath: "\/runtime-cache"/);
  assert.doesNotMatch(rendered, /\/runtime-cache\//);
  assert.doesNotMatch(rendered, /XDG_CACHE_HOME/);
});

test("Blockcast values route agent LLM traffic through Penstock gateway", () => {
  const renderedStatefulSet = renderStatefulSet();
  const renderedApiDeployment = renderApiDeployment();

  for (const rendered of [renderedStatefulSet, renderedApiDeployment]) {
    assertValueEnv(rendered, "ANTHROPIC_BASE_URL", "https://api.penstock.run/anthropic");
    assertPenstockOrgKeySecretEnv(rendered, "ANTHROPIC_AUTH_TOKEN");
    assertPenstockOrgKeySecretEnv(rendered, "ANTHROPIC_API_KEY");
    assertNoLegacyProviderSecretEnv(rendered, "ANTHROPIC_AUTH_TOKEN");
    assertNoLegacyProviderSecretEnv(rendered, "ANTHROPIC_API_KEY");
    assertValueEnv(rendered, "OPENAI_BASE_URL", "https://api.penstock.run/v1");
    assertValueEnv(rendered, "OPENAI_API_BASE", "https://api.penstock.run/v1");
    assertValueEnv(rendered, "OPENAI_API_BASE_URL", "https://api.penstock.run/v1");
    assertPenstockOrgKeySecretEnv(rendered, "OPENAI_API_KEY");
    assertNoLegacyProviderSecretEnv(rendered, "OPENAI_API_KEY");
    assertCodexPenstockProvider(rendered);
    assert.doesNotMatch(
      rendered,
      /https:\/\/paperclip\.blockcast\.net\/ccrotate/,
      "agent LLM traffic must not use the public auth-proxy endpoint",
    );
    assert.doesNotMatch(
      rendered,
      /paperclip-ccrotate-board-token/,
      "agent provider env refs must not inherit the board-session bearer",
    );
  }
});
