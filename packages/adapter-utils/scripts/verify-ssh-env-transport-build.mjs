#!/usr/bin/env node
// Verifies the BUILT artifact (packages/adapter-utils/dist/ssh.js) — not the
// TypeScript source — still keeps SSH environment values off argv.
//
// The source-level tests run through vitest against src/, so they cannot show
// that the JavaScript a published/installed consumer actually loads carries the
// framed stdin transport. Run this after
// `pnpm --filter @paperclipai/adapter-utils build`, from the repository root:
//
//   node cli/node_modules/tsx/dist/cli.mjs \
//     packages/adapter-utils/scripts/verify-ssh-env-transport-build.mjs
//
// dist/ssh.js is the module under test; tsx is only needed because the
// workspace `exports` of @paperclipai/shared point at TypeScript sources that
// plain node cannot resolve before that package is packed.
//
// Exit status 0 means every check passed. Only a harmless canary value is used;
// no real secret is ever read or printed.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const distSsh = path.join(here, "..", "dist", "ssh.js");
const { buildSshRunCommandTarget, buildSshRunnerRemoteCommand, buildSshSpawnTarget } = await import(
  pathToFileURL(distSsh).href
);

const CANARY = "paperclip-build-canary-not-a-secret";
const CANARY_B64 = Buffer.from(CANARY, "utf8").toString("base64");
const ENV = { PAPERCLIP_API_KEY: CANARY, PAPERCLIP_AGENT_ID: "agent-fixture" };

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  const suffix = !ok && detail ? ` :: ${detail}` : "";
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${suffix}`);
}

function checkArgvIsClean(label, argv) {
  const rendered = argv.join("\0");
  check(`${label}: canary value absent from argv`, !rendered.includes(CANARY));
  check(`${label}: encoded canary absent from argv`, !rendered.includes(CANARY_B64));
  // The two pre-fix transports this build must no longer contain.
  check(`${label}: no 'exec env KEY=VAL' transport`, !rendered.includes("exec env "));
  check(`${label}: no 'export KEY=VAL;' transport`, !/export PAPERCLIP_API_KEY=/.test(rendered));
  check(`${label}: no bare 'KEY=' assignment in argv`, !rendered.includes("PAPERCLIP_API_KEY="));
}

function checkFrame(label, stdinPrefix) {
  const prefix = stdinPrefix ?? "";
  check(`${label}: framed stdin prefix present`, prefix.startsWith("PAPERCLIP_SSH_ENV_V1\n"));
  check(`${label}: canary travels base64 on stdin`, prefix.includes(`PAPERCLIP_API_KEY\t${CANARY_B64}`));
  check(`${label}: frame terminated`, prefix.includes("\nPAPERCLIP_SSH_ENV_END\n"));
}

// --- the emitted file itself ------------------------------------------------
// Both pre-fix transports were literal template fragments, so their absence
// from the emitted text is directly checkable.
const emitted = readFileSync(distSsh, "utf8");
check("artifact: no `exec env ` fragment", !emitted.includes("exec env "));
check("artifact: no `env ${envArgs` fragment", !emitted.includes("env ${envArgs"));
check("artifact: no `export ${key}=` fragment", !emitted.includes("export ${key}="));
check("artifact: framed transport present", emitted.includes("PAPERCLIP_SSH_ENV_V1"));

// --- runSshCommand path -----------------------------------------------------
const runnerRemoteCommand = buildSshRunnerRemoteCommand({
  command: "sh",
  args: ["-c", "printenv PAPERCLIP_API_KEY"],
  cwd: "/remote/workspace",
});
check(
  "runner remote command carries no environment at all",
  !runnerRemoteCommand.includes("exec env ") && !runnerRemoteCommand.includes("export "),
  runnerRemoteCommand,
);

const runTarget = buildSshRunCommandTarget({ remoteCommand: runnerRemoteCommand, env: ENV });
checkArgvIsClean("runSshCommand", [runTarget.remoteArgument]);
checkFrame("runSshCommand", runTarget.stdinPrefix);
check("runSshCommand: stdin reader installed", runTarget.remoteArgument.includes("__paperclip_env_header"));
check("runSshCommand: payload is exec'd", runTarget.remoteArgument.includes("&& exec sh -c "));

const noEnvTarget = buildSshRunCommandTarget({ remoteCommand: runnerRemoteCommand });
check("runSshCommand: no environment -> no frame", noEnvTarget.stdinPrefix === undefined);
check("runSshCommand: no environment -> plain exec", noEnvTarget.remoteArgument.includes("exec sh -c "));
for (const key of ["PAPERCLIP_SSH_ENV_END", "__paperclip_env_complete"]) {
  let rejected = false;
  try {
    buildSshRunCommandTarget({ remoteCommand: runnerRemoteCommand, env: { [key]: "fixture" } });
  } catch {
    rejected = true;
  }
  check(`runSshCommand: reserved key ${key} rejected`, rejected);
}

// --- spawn path -------------------------------------------------------------
const spawnTarget = await buildSshSpawnTarget({
  spec: {
    host: "ssh.example.test",
    port: 22,
    username: "paperclip",
    remoteWorkspacePath: "/remote/workspace",
    remoteCwd: "/remote/workspace",
    privateKey: null,
    knownHosts: null,
    strictHostKeyChecking: true,
  },
  command: "node",
  args: ["agent.js"],
  env: ENV,
});
try {
  checkArgvIsClean("buildSshSpawnTarget", spawnTarget.args);
  checkFrame("buildSshSpawnTarget", spawnTarget.stdinPrefix);
  const remoteArgument = spawnTarget.args.at(-1) ?? "";
  check("buildSshSpawnTarget: stdin reader installed", remoteArgument.includes("__paperclip_env_header"));
  // The remote script is single-quoted for `sh -c`, so its own quotes are escaped.
  const unquoted = remoteArgument.replaceAll(`'"'"'`, "'");
  check("buildSshSpawnTarget: payload is exec'd", unquoted.includes("&& exec 'node' 'agent.js'"));
} finally {
  await spawnTarget.cleanup();
}

for (const key of ["PAPERCLIP_SSH_ENV_END", "__paperclip_env_complete"]) {
  let rejected = false;
  try {
    await buildSshSpawnTarget({
      spec: {
        host: "ssh.example.test",
        port: 22,
        username: "paperclip",
        remoteWorkspacePath: "/remote/workspace",
        remoteCwd: "/remote/workspace",
        privateKey: null,
        knownHosts: null,
        strictHostKeyChecking: true,
      },
      command: "node",
      args: ["agent.js"],
      env: { [key]: "fixture" },
    });
  } catch {
    rejected = true;
  }
  check(`buildSshSpawnTarget: reserved key ${key} rejected`, rejected);
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
