import { spawn } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createPiLaunchSpec } from "../src/drivers/acpx/pi-acp-runtime.ts";

const usage = "node packages/paperclip-runner/scripts/probe-local-pi-profile.mjs"
  + " --entrypoint /path/to/pi/dist/cli.js --profile /path/to/pi/agent"
  + " --workspace /path/to/test-repo [--extension /path/to/trusted-extension.js]... [--expect-command command]... [--model provider/id]";

async function requirePath(path, kind, option) {
  if (!path || !isAbsolute(path)) throw new Error(`--${option} requires an absolute path`);
  const physical = await realpath(path).catch(() => null);
  const info = physical ? await stat(physical) : null;
  if (kind === "directory" ? !info?.isDirectory() : !info?.isFile()) {
    throw new Error(`--${option} does not name a ${kind}`);
  }
  return physical;
}

async function stageRunnerExtension(root) {
  const source = new URL("../src/drivers/acpx/", import.meta.url);
  for (const module of ["pi-acp-runtime", "pi-runtime-extension"]) {
    const text = await readFile(new URL(`${module}.ts`, source), "utf8");
    await writeFile(join(root, `${module}.js`), stripTypeScriptTypes(text));
  }
  await writeFile(join(root, "package.json"), '{"type":"module"}\n');
  return join(root, "pi-runtime-extension.js");
}

async function probeRpc(launch, model, expectedCommands) {
  // Print mode can hide extension startup errors. Require the same readiness
  // command as the ACP wrapper, and use get_state to check the exact model.
  const child = spawn(launch.command, launch.args, {
    cwd: launch.cwd,
    env: launch.env,
    stdio: ["pipe", "pipe", "ignore"],
  });
  const closed = new Promise(resolve => {
    child.once("close", resolve);
  });
  const lines = createInterface({ input: child.stdout });
  // A late EPIPE during cleanup must not mask the original probe error.
  child.stdin.on("error", () => {});
  function request(type) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error(`Pi RPC ${type} timed out`)), 15_000);
      function finish(error, result) {
        clearTimeout(timer);
        lines.off("line", receive);
        child.off("close", exited);
        child.off("error", failed);
        child.stdin.off("error", failed);
        if (error) reject(error);
        else resolve(result);
      }
      function receive(line) {
        let message;
        try { message = JSON.parse(line); }
        catch { return; }
        if (message.type !== "response" || message.id !== type) return;
        if (!message.success) finish(new Error(`Pi RPC ${type} failed`));
        else finish(null, message.data);
      }
      function exited() { finish(new Error(`Pi exited before RPC ${type} completed`)); }
      function failed() { finish(new Error("Could not start or communicate with Pi")); }
      lines.on("line", receive);
      child.once("close", exited);
      child.once("error", failed);
      child.stdin.once("error", failed);
      child.stdin.write(`${JSON.stringify({ id: type, type })}\n`);
    });
  }
  try {
    const result = await request("get_commands");
    if (!result?.commands?.some(command =>
      command.name === "paperclip-runtime-ready-v1" && command.description === "Paperclip runtime gate v1")) {
      throw new Error("Pi did not register the Paperclip runtime gate");
    }
    for (const name of expectedCommands) {
      if (!result.commands.some(command => command.name === name)) {
        throw new Error(`Pi did not register the expected extension command: ${name}`);
      }
    }
    if (model) {
      const state = await request("get_state");
      if (state?.model && `${state.model.provider}/${state.model.id}` === model) return;
      throw new Error("Pi did not select the requested provider/model from this profile");
    }
  } finally {
    lines.close();
    child.stdin.end();
    child.kill("SIGTERM");
    const deadline = setTimeout(() => child.kill("SIGKILL"), 1_000);
    try { await closed; }
    finally { clearTimeout(deadline); }
  }
}

export async function inspectLocalPiProfile(argv) {
  const { values } = parseArgs({ args: argv, options: {
    entrypoint: { type: "string" },
    profile: { type: "string" },
    workspace: { type: "string" },
    extension: { type: "string", multiple: true, default: [] },
    "expect-command": { type: "string", multiple: true, default: [] },
    model: { type: "string" },
    help: { type: "boolean" },
  } });
  if (values.help) return usage;
  if (values.model !== undefined && !/^[^/\s]+\/\S+$/.test(values.model)) {
    throw new Error("--model requires an exact provider/model ID");
  }
  const entrypoint = await requirePath(values.entrypoint, "file", "entrypoint");
  const profile = await requirePath(values.profile, "directory", "profile");
  const workspace = await requirePath(values.workspace, "directory", "workspace");
  const extensions = await Promise.all(values.extension.map(path => requirePath(path, "file", "extension")));
  const root = await mkdtemp(join(tmpdir(), "paperclip-local-pi-probe-"));
  try {
    const runnerExtension = await stageRunnerExtension(root);
    const launch = createPiLaunchSpec({ cwd: workspace }, {
      HOME: root,
      PATH: process.env.PATH,
      PI_CODING_AGENT_DIR: profile,
      PI_TELEMETRY: "0",
      PI_SKIP_VERSION_CHECK: "1",
      PAPERCLIP_ACPX_ISOLATED_CONTEXT: "1",
      PAPERCLIP_PI_NODE_EXECUTABLE: await realpath(process.execPath),
      PAPERCLIP_PI_ENTRYPOINT: entrypoint,
      PAPERCLIP_PI_EXTENSION_PATH: runnerExtension,
      PAPERCLIP_PI_READ_ONLY: "1",
      PAPERCLIP_PI_PROTECTED_ROOTS: JSON.stringify([root, profile, dirname(entrypoint)]),
    });
    // Local operators select exact paths. Keep discovery disabled even here.
    launch.args.push("--no-session", ...extensions.flatMap(path => ["-e", path]));
    if (values.model) {
      const separator = values.model.indexOf("/");
      launch.args.push("--provider", values.model.slice(0, separator), "--model", values.model.slice(separator + 1));
    }
    await probeRpc({ ...launch, cwd: workspace }, values.model, values["expect-command"]);
    return "Pi RPC compatibility probe passed.";
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try { console.log(await inspectLocalPiProfile(process.argv.slice(2))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
