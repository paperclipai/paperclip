import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const installSh = path.join(repoRoot, "scripts", "install.sh");

function stripComments(source) {
  return source
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

test("install.sh avoids bash-4-only ${var,,} lowercase expansion", () => {
  const source = readFileSync(installSh, "utf8");
  const executable = stripComments(source);
  assert.equal(
    /\$\{[^}]+,,\}/.test(executable),
    false,
    "scripts/install.sh must not use ${value,,}; macOS ships bash 3.2",
  );
  assert.match(
    source,
    /tr '\[:upper:\]' '\[:lower:\]'/,
    "parse_bool should lowercase with portable tr",
  );
});

test("install.sh passes bash -n syntax check", () => {
  const result = spawnSync("bash", ["-n", installSh], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("install.sh dry-run succeeds under /bin/bash on this host", () => {
  const bashPath = process.platform === "darwin" ? "/bin/bash" : "bash";
  const result = spawnSync(
    bashPath,
    [installSh, "--no-prompt", "--no-onboard", "--dry-run"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        // Keep the dry-run deterministic and non-interactive.
        PAPERCLIP_INSTALL_NO_PROMPT: "1",
      },
    },
  );
  assert.equal(
    result.status,
    0,
    `dry-run failed under ${bashPath}:\n${result.stderr}\n${result.stdout}`,
  );
  assert.match(result.stdout, /paperclipai@canary/);
  assert.doesNotMatch(result.stdout, /paperclipai@latest/);
  assert.doesNotMatch(result.stderr + result.stdout, /bad substitution/);
});
