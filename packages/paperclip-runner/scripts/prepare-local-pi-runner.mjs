import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, cp, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { basename, dirname, isAbsolute, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseArgs } from "node:util";
import { inventoryPiRuntimeFiles } from "../src/drivers/acpx/pi-verified-runtime.ts";
import { PI_DISTRIBUTION_PINS, piDistributionBootstrapSource } from "./materialize-pi-distribution.mjs";

const npmPi = "node_modules/@earendil-works/pi-coding-agent/dist/cli.js";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const run = promisify(execFile);
const { values } = parseArgs({ options: {
  installation: { type: "string" },
  output: { type: "string" },
  profile: { type: "string" },
  company: { type: "string" },
  agent: { type: "string" },
  extension: { type: "string", multiple: true, default: [] },
} });
for (const name of ["installation", "output", "profile"]) {
  if (!values[name] || !isAbsolute(values[name])) throw new Error(`--${name} requires an absolute path`);
}
for (const name of ["company", "agent"]) {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(values[name] ?? "")) throw new Error(`--${name} requires a Paperclip ID`);
}
const installation = await realpath(values.installation);
const profile = await realpath(values.profile);
const output = join(await realpath(dirname(values.output)), basename(values.output));
const modules = join(installation, "node_modules");
if (output === modules || output.startsWith(modules + sep)) throw new Error("Output cannot be inside the npm package tree");
if (await lstat(output).then(() => true, error => {
  if (error.code === "ENOENT") return false;
  throw error;
})) throw new Error("Local Pi Runner output already exists");
const approvedExtensions = values.extension.map(path => {
  if (!path.startsWith("node_modules/") || path.split("/").some(segment => segment === "." || segment === ".." || !segment)
    || /[^a-zA-Z0-9_@./-]/.test(path)) throw new Error("An extension must be relative to the installation's node_modules");
  return path;
});
const staging = await mkdtemp(join(dirname(output), ".paperclip-local-pi-"));
try {
  const runtime = join(staging, "runtime");
  await mkdir(join(runtime, "node/bin"), { recursive: true });
  // Snapshot the installed tree. Reject workspace links and package-manager
  // indirection so every executable dependency will be in the sealed closure.
  await cp(modules, join(runtime, "node_modules"), {
    recursive: true,
    filter: path => ![".bin", ".package-lock.json"].includes(basename(path)),
  });
  for (const path of [npmPi, ...approvedExtensions]) {
    const file = join(runtime, path);
    if (!(await lstat(file)).isFile() || await realpath(file) !== file) throw new Error("A selected Pi entrypoint escaped the installation");
  }
  const wrapper = join(runtime, "node_modules/pi-acp");
  const patch = fileURLToPath(new URL("../../../patches/pi-acp@0.0.33.patch", import.meta.url));
  await run("git", ["apply", patch], { cwd: wrapper, timeout: 10_000 });
  for (const [path, digest] of [
    ["dist/index.js", PI_DISTRIBUTION_PINS.wrapperSha256],
    ["dist/paperclip-runtime.js", PI_DISTRIBUTION_PINS.helperSha256],
  ]) {
    if (hash(await readFile(join(wrapper, path))) !== digest) throw new Error("The local installation requires Paperclip's exact Pi ACP wrapper");
  }
  const extension = await readFile(new URL("../src/drivers/acpx/pi-runtime-extension.ts", import.meta.url), "utf8");
  await mkdir(join(runtime, "extensions"));
  await writeFile(join(runtime, "extensions/paperclip.js"), stripTypeScriptTypes(extension)
    .replace('from "./pi-acp-runtime.js"', 'from "../node_modules/pi-acp/dist/paperclip-runtime.js"'));
  const selectedCli = "selected-pi.cjs";
  const bootstrap = piDistributionBootstrapSource().replace(npmPi, selectedCli);
  await writeFile(join(runtime, "pi-entry.cjs"), bootstrap);
  // The wrapper still runs the Paperclip extension and turns discovery off.
  // Additional trusted entrypoints are part of the same sealed snapshot.
  await writeFile(join(runtime, selectedCli), `
    const { join } = require("node:path");
    const { pathToFileURL } = require("node:url");
    const cli = join(__dirname, ${JSON.stringify(npmPi)});
    process.argv[1] = cli;
    for (const extension of ${JSON.stringify(approvedExtensions)}) process.argv.push("-e", join(__dirname, extension));
    import(pathToFileURL(cli).href).catch(() => { process.exitCode = 1; });
  `);
  const node = join(runtime, "node/bin/node");
  await copyFile(await realpath(process.execPath), node);
  await chmod(node, 0o755);
  const inventory = await inventoryPiRuntimeFiles(runtime);
  const entries = await Promise.all(inventory.map(async file => {
    if (file.kind !== "file") throw new Error("The local Pi installation must contain regular files only. Use an npm installation without links.");
    const stat = await lstat(join(runtime, ...file.path.split(sep)));
    return { path: file.path, sha256: file.sha256.slice(7), size: stat.size, executable: Boolean(stat.mode & 0o111) };
  }));
  entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const sha256 = hash(JSON.stringify(entries));
  await writeFile(join(staging, "native-closure.json"), JSON.stringify({ entries }));
  await rename(staging, output);
  console.log(JSON.stringify({ assets: output, sha256, profile, companyId: values.company, agentId: values.agent }));
} finally {
  await rm(staging, { force: true, recursive: true });
}
