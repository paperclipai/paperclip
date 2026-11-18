import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  createBundledInstallManifest,
  materializePublishManifest,
  selectBundledDependencyPatches,
} from "./prepare-bundled-package.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const rootPackage = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const serverPackage = JSON.parse(
  readFileSync(new URL("../server/package.json", import.meta.url), "utf8"),
);
const workspace = readFileSync(
  new URL("../pnpm-workspace.yaml", import.meta.url),
  "utf8",
);
const required = [
  ["@chat-adapter/discord", "4.39.0"],
  ["@chat-adapter/github", "4.39.0"],
  ["@chat-adapter/slack", "4.39.0"],
  ["@chat-adapter/teams", "4.39.0"],
  ["@chat-adapter/telegram", "4.39.0"],
  ["@discordjs/ws", "1.2.3"],
  ["node-pty", "1.1.0"],
];

for (const [name, version] of required) {
  test(`published server retains the patched ${name}@${version} runtime`, () => {
    const published = materializePublishManifest(serverPackage);
    const installed = createBundledInstallManifest(
      published,
      serverPackage.bundleDependencies,
    );
    assert.equal(
      serverPackage.dependencies[name] ?? serverPackage.optionalDependencies?.[name],
      version,
      "the patched runtime must have an exact direct version",
    );
    assert.ok(
      serverPackage.bundleDependencies.includes(name),
      "npm consumers cannot apply this repository's pnpm patches",
    );
    assert.equal(
      installed.dependencies?.[name] ?? installed.optionalDependencies?.[name],
      version,
      "release staging must install the runtime before patching",
    );
    assert.ok(
      published.bundleDependencies.includes(name),
      "the patched runtime must remain in the published tarball",
    );
    const specifier = `${name}@${version}`;
    const patchPath = rootPackage.pnpm.patchedDependencies[specifier];
    assert.equal(typeof patchPath, "string");
    assert.ok(
      workspace.includes(`"${specifier}": ${patchPath}`),
      "both supported pnpm configuration paths must match",
    );
    // Parse the actual full patch, not merely its configured filename. This is
    // read-only; clean-package materialization is a separate qualification.
    execFileSync("git", ["apply", "--stat", patchPath], {
      cwd: repoRoot,
      stdio: "pipe",
    });
  });
}

test("release selection includes every patched bundled runtime", (t) => {
  const destination = mkdtempSync(
    join(tmpdir(), "paperclip-chat-release-contract-"),
  );
  t.after(() => rmSync(destination, { recursive: true, force: true }));
  const expected = serverPackage.bundleDependencies.flatMap((name) => {
    const version = serverPackage.dependencies[name] ?? serverPackage.optionalDependencies?.[name];
    const specifier = `${name}@${version}`;
    return version && rootPackage.pnpm.patchedDependencies[specifier]
      ? [[name, version]]
      : [];
  });
  for (const [name, version] of expected) {
    const directory = join(destination, "node_modules", name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({ name, version }),
    );
  }
  const selected = selectBundledDependencyPatches(
    destination,
    serverPackage.bundleDependencies,
    rootPackage.pnpm.patchedDependencies,
  );
  assert.deepEqual(
    selected.map(({ specifier }) => specifier).sort(),
    [
      ...expected.map(([name, version]) => `${name}@${version}`),
    ].sort(),
  );
  writeFileSync(
    join(destination, "node_modules", "@discordjs/ws", "package.json"),
    JSON.stringify({
      name: "@discordjs/ws",
      version: "1.2.4",
    }),
  );
  assert.throws(
    () =>
      selectBundledDependencyPatches(
        destination,
        serverPackage.bundleDependencies,
        rootPackage.pnpm.patchedDependencies,
      ),
    /installed @discordjs\/ws@1\.2\.4/,
  );
});
