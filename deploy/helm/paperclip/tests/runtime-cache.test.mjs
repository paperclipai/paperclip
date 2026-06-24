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

function assertCcrotateServeSecretEnv(rendered, envName) {
  assert.match(
    rendered,
    new RegExp(
      `- name: ${escapeRegExp(envName)}\\n` +
        "\\s+valueFrom:\\n" +
        "\\s+secretKeyRef:\\n" +
        "\\s+key: serveToken\\n" +
        "\\s+name: paperclip-ccrotate-serve-secrets",
    ),
    `${envName} should inherit the ccrotate-serve bearer secret`,
  );
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

test("Blockcast values inherit ccrotate-serve bearer for Anthropic agent traffic", () => {
  const renderedStatefulSet = renderStatefulSet();
  const renderedApiDeployment = renderApiDeployment();

  for (const rendered of [renderedStatefulSet, renderedApiDeployment]) {
    assert.match(
      rendered,
      /- name: ANTHROPIC_BASE_URL\n\s+value: "?http:\/\/ccrotate-serve\.paperclip\.svc:4001"?/,
      "agent Anthropic traffic must use the in-cluster ccrotate-serve endpoint",
    );
    assertCcrotateServeSecretEnv(rendered, "ANTHROPIC_AUTH_TOKEN");
    assertCcrotateServeSecretEnv(rendered, "ANTHROPIC_API_KEY");
    assert.doesNotMatch(
      rendered,
      /https:\/\/paperclip\.blockcast\.net\/ccrotate/,
      "agent Anthropic traffic must not use the public auth-proxy endpoint",
    );
    assert.doesNotMatch(
      rendered,
      /paperclip-ccrotate-board-token/,
      "agent Anthropic env refs must not inherit the board-session bearer",
    );
  }
});
