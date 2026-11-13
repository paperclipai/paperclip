import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const makeFixture = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-app-overrides-"));
  for (const relative of [
    "scripts/ingest-app-definitions.mjs",
    "scripts/app-definition-overrides",
    "packages/shared/src/app-definitions",
    "packages/shared/src/self-serve-mcp-research.json",
    "doc/connections/tool-method-permission-reviews.json",
    "ui/public/brands/apps/manifest.json",
  ]) {
    const source = path.join(repoRoot, relative);
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(source, target, { recursive: true });
  }
  return root;
};

const runIngestion = (root) =>
  spawnSync(process.execPath, ["scripts/ingest-app-definitions.mjs", "--definitions-only"], {
    cwd: root,
    encoding: "utf8",
  });

test("provider overrides keep manifest branding and pass normal review validation", (t) => {
  const root = makeFixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const definitionPath = path.join(root, "packages/shared/src/app-definitions/github.json");
  const definition = JSON.parse(fs.readFileSync(definitionPath, "utf8"));
  definition.name = "GitHub override fixture";
  definition.branding = { logoUrl: "https://untrusted.invalid/logo.svg" };
  fs.writeFileSync(
    path.join(root, "scripts/app-definition-overrides/github.json"),
    JSON.stringify(definition),
  );

  const result = runIngestion(root);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const emitted = JSON.parse(fs.readFileSync(definitionPath, "utf8"));
  assert.equal(emitted.name, "GitHub override fixture");
  assert.deepEqual(emitted.branding, {
    logoUrl: "/brands/apps/github.svg",
    darkLogoUrl: "/brands/apps/github-dark.svg",
  });
});

test("provider overrides cannot add an unreviewed tool method", (t) => {
  const root = makeFixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const definitionPath = path.join(root, "packages/shared/src/app-definitions/github.json");
  const definition = JSON.parse(fs.readFileSync(definitionPath, "utf8"));
  definition.methods.push({
    key: "mcp-unreviewed-fixture",
    transport: "mcp_remote",
    auth: "api_key",
    ownershipModes: ["customer"],
    defaults: { serverUrl: "https://mcp.github.com" },
    credentialFields: [
      { key: "authorization", label: "Token", type: "password", required: true, placeholder: "token", secret: true },
    ],
    keyPlacement: { location: "header", name: "Authorization", prefix: "Bearer " },
  });
  fs.writeFileSync(
    path.join(root, "scripts/app-definition-overrides/github.json"),
    JSON.stringify(definition),
  );

  const result = runIngestion(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /github\/mcp-unreviewed-fixture: permission review required/);
});

test("Tavily curated MCP methods opt into initialized sessions", (t) => {
  const root = makeFixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const overridePath = path.join(root, "scripts/app-definition-overrides/tavily.json");
  const override = JSON.parse(fs.readFileSync(overridePath, "utf8"));
  assert.equal(override.methods[0].defaults.mcpSessionRequired, true);

  const result = runIngestion(root);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const emittedPath = path.join(root, "packages/shared/src/app-definitions/tavily.json");
  const emitted = JSON.parse(fs.readFileSync(emittedPath, "utf8"));
  assert.equal(emitted.methods[0].defaults.mcpSessionRequired, true);
});
