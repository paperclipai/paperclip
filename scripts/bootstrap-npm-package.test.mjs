import assert from "node:assert/strict";
import test from "node:test";

import { buildPublishArgs, parseArgs, resolveTargetPackage } from "./bootstrap-npm-package.mjs";

test("parseArgs recognizes publish and skip-build flags", () => {
  assert.deepEqual(parseArgs(["@paperclipai/plugin-workspace-diff", "--publish", "--skip-build"]), {
    help: false,
    selector: "@paperclipai/plugin-workspace-diff",
    publish: true,
    skipBuild: true,
    otp: null,
  });
});

test("parseArgs accepts an explicit otp value", () => {
  assert.deepEqual(parseArgs(["packages/plugins/plugin-workspace-diff", "--publish", "--otp", "123456"]), {
    help: false,
    selector: "packages/plugins/plugin-workspace-diff",
    publish: true,
    skipBuild: false,
    otp: "123456",
  });
});

test("parseArgs leaves otp null when omitted", () => {
  assert.deepEqual(parseArgs(["packages/plugins/plugin-workspace-diff", "--publish"]), {
    help: false,
    selector: "packages/plugins/plugin-workspace-diff",
    publish: true,
    skipBuild: false,
    otp: null,
  });
});

test("parseArgs returns help mode", () => {
  assert.deepEqual(parseArgs(["--help"]), {
    help: true,
    selector: null,
    publish: false,
    skipBuild: false,
    otp: null,
  });
});

test("resolveTargetPackage matches by package name or dir", () => {
  const packages = [
    { dir: "packages/a", name: "@paperclipai/a", pkg: {} },
    { dir: "packages/b", name: "@paperclipai/b", pkg: {} },
  ];

  assert.equal(resolveTargetPackage("@paperclipai/a", packages).dir, "packages/a");
  assert.equal(resolveTargetPackage("./packages/b", packages).name, "@paperclipai/b");
});

test("resolveTargetPackage includes the workspace diff plugin bootstrap package", () => {
  const pkg = resolveTargetPackage("@paperclipai/plugin-workspace-diff");

  assert.equal(pkg.dir, "packages/plugins/plugin-workspace-diff");
});

test("buildPublishArgs publishes from the repo root through pnpm", () => {
  const pkg = { dir: "packages/adapters/hermes", name: "@paperclipai/hermes-paperclip-adapter" };

  assert.deepEqual(buildPublishArgs(pkg), [
    "publish",
    "packages/adapters/hermes",
    "--no-git-checks",
    "--access",
    "public",
  ]);
});

test("buildPublishArgs includes dry-run and otp flags when requested", () => {
  const pkg = { dir: "packages/adapters/hermes", name: "@paperclipai/hermes-paperclip-adapter" };

  assert.deepEqual(buildPublishArgs(pkg, { dryRun: true, otp: "123456" }), [
    "publish",
    "packages/adapters/hermes",
    "--no-git-checks",
    "--access",
    "public",
    "--dry-run",
    "--otp",
    "123456",
  ]);
});
