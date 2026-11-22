import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, closeSync, copyFileSync, cpSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runnerBinaryFileTarget } from "../packages/paperclip-runner/src/live/runner-binary.ts";

const schema = "paperclip.runner.remote-runtime.v1";
const target = "darwin-arm64";
const sha = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : value && typeof value === "object" ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}` : JSON.stringify(value);

function shaFile(path, limit = 2 * 1024 ** 3) {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > limit) throw Error("Invalid remote runtime file");
  const fd = openSync(path, "r"), hash = createHash("sha256"), buffer = Buffer.alloc(1024 * 1024);
  let total = 0;
  try {
    let bytes;
    while ((bytes = readSync(fd, buffer, 0, buffer.length, null))) {
      total += bytes;
      if (total > metadata.size) throw Error("Remote runtime file changed");
      hash.update(buffer.subarray(0, bytes));
    }
    const after = fstatSync(fd);
    if (total !== metadata.size || after.size !== metadata.size || after.mtimeMs !== metadata.mtimeMs) throw Error("Remote runtime file changed");
    return `sha256:${hash.digest("hex")}`;
  } finally { closeSync(fd); }
}

export function createOpenCodeRuntimePack(source, destination) {
  const sourceRoot = realpathSync(source);
  const manifest = JSON.parse(readFileSync(join(sourceRoot, "provider-pack.json"), "utf8"));
  if (manifest.digest !== sha(canonical(manifest.payload))) throw Error("Invalid source provider pack digest");
  mkdirSync(destination, { recursive: true });
  cpSync(join(sourceRoot, "dist"), join(destination, "dist"), { recursive: true, verbatimSymlinks: true });
  for (const artifact of Object.values(manifest.payload.artifacts)) {
    const path = artifact.path;
    if (typeof path !== "string" || isAbsolute(path) || path.includes("\\") || path.split("/").some(part => !part || part === "." || part === "..")) throw Error("Invalid runtime artifact path");
    const file = realpathSync(join(sourceRoot, path));
    if (relative(sourceRoot, file).startsWith("..") || shaFile(file) !== artifact.sha256) throw Error("Invalid runtime artifact identity");
    const target = join(destination, path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(file, target);
    chmodSync(target, lstatSync(file).mode & 0o777);
  }
  for (const [name, pin] of Object.entries({ acpx: "acpx", "@agentclientprotocol/claude-agent-acp": "claudeAcp",
    "@agentclientprotocol/codex-acp": "codexAcp", "opencode-ai": "opencode" })) {
    const path = join("node_modules", name, "package.json"), file = realpathSync(join(sourceRoot, path));
    if (relative(sourceRoot, file).startsWith("..") || JSON.parse(readFileSync(file, "utf8")).version !== manifest.payload.pins[pin]) {
      throw Error(`Invalid runtime package metadata: ${name}`);
    }
    mkdirSync(dirname(join(destination, path)), { recursive: true });
    copyFileSync(file, join(destination, path));
  }
  delete manifest.payload.providers;
  delete manifest.payload.candidateProviders;
  manifest.digest = sha(canonical(manifest.payload));
  writeFileSync(join(destination, "provider-pack.json"), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

export function verifyMacRuntime(directory, sourceRevision, inputsDigest) {
  const root = resolve(directory);
  if (realpathSync(root) !== root) throw Error("Remote runtime must be a canonical directory");
  const metadata = JSON.parse(readFileSync(join(root, "runtime.json"), "utf8"));
  const pack = JSON.parse(readFileSync(join(root, "provider-pack/provider-pack.json"), "utf8"));
  const binary = join(root, "bin/paperclip-runnerd"), runner = lstatSync(binary);
  if (metadata.schema !== schema || metadata.target !== target || !/^[a-f0-9]{40}$/.test(sourceRevision ?? "")
    || metadata.sourceRevision !== sourceRevision || pack.payload?.runnerSourceRevision !== sourceRevision
    || (inputsDigest !== undefined && metadata.runtimeInputsDigest !== inputsDigest)
    || pack.schema !== "paperclip-runner/remote-provider-pack/v1"
    || pack.payload?.target?.platform !== "darwin" || pack.payload?.target?.architecture !== "arm64"
    || pack.payload?.pins?.opencode !== "1.18.34"
    || metadata.providerPackDigest !== pack.digest || pack.digest !== sha(canonical(pack.payload))
    || !runner.isFile() || runner.isSymbolicLink() || (runner.mode & 0o111) === 0
    || runnerBinaryFileTarget(binary) !== target || metadata.runnerSha256 !== shaFile(binary)) {
    throw Error("Remote macOS runtime source, target, pin or digest mismatch");
  }
  return metadata;
}

export function packageMacRuntime({ providerPack, runnerBinary, sourceRevision, output, inputsDigest }) {
  if (inputsDigest !== undefined && !/^sha256:[a-f0-9]{64}$/.test(inputsDigest)) throw Error("Invalid runtime inputs digest");
  if (`${process.platform}-${process.arch}` !== target) throw Error("Build the macOS runtime on a native Apple Silicon host");
  if (existsSync(output)) throw Error("Remote runtime output already exists");
  const root = join(resolve(output), target);
  mkdirSync(join(root, "bin"), { recursive: true });
  try {
    createOpenCodeRuntimePack(providerPack, join(root, "provider-pack"));
    copyFileSync(runnerBinary, join(root, "bin/paperclip-runnerd"));
    chmodSync(join(root, "bin/paperclip-runnerd"), 0o755);
    const pack = JSON.parse(readFileSync(join(root, "provider-pack/provider-pack.json"), "utf8"));
    writeFileSync(join(root, "runtime.json"), JSON.stringify({ schema, sourceRevision, target, ...(inputsDigest ? { runtimeInputsDigest: inputsDigest } : {}),
      providerPackDigest: pack.digest, runnerSha256: shaFile(join(root, "bin/paperclip-runnerd")) }, null, 2) + "\n");
    const metadata = verifyMacRuntime(root, sourceRevision);
    const archive = join(resolve(output), `${target}.tar.gz`);
    execFileSync("tar", ["-czf", archive, "-C", resolve(output), target], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
    writeFileSync(join(resolve(output), `${target}.json`), JSON.stringify({ ...metadata, archiveSha256: shaFile(archive) }, null, 2) + "\n");
    rmSync(root, { recursive: true });
    return metadata;
  } catch (error) {
    rmSync(output, { recursive: true, force: true });
    throw error;
  }
}

export function installMacRuntime({ input, output, sourceRevision, inputsDigest }) {
  if (inputsDigest !== undefined && !/^sha256:[a-f0-9]{64}$/.test(inputsDigest)) throw Error("Invalid runtime inputs digest");
  const names = readdirSync(input).filter(name => name !== ".gitkeep").sort();
  if (names.length === 0) return false;
  if (names.join() !== `${target}.json,${target}.tar.gz`) throw Error("Unexpected remote runtime input files");
  const metadata = JSON.parse(readFileSync(join(input, `${target}.json`), "utf8"));
  const archive = join(input, `${target}.tar.gz`);
  if ((metadata.sourceRevision !== sourceRevision && (!inputsDigest || metadata.runtimeInputsDigest !== inputsDigest))
    || (inputsDigest && metadata.runtimeInputsDigest !== inputsDigest)
    || metadata.archiveSha256 !== shaFile(archive)) throw Error("Remote runtime archive source or digest mismatch");
  if (existsSync(join(output, target))) throw Error("Remote runtime destination already exists");
  mkdirSync(output, { recursive: true });
  if (realpathSync(output) !== resolve(output)) throw Error("Remote runtime output must be canonical");
  execFileSync("python3", ["-c", `import pathlib,sys,tarfile
archive,destination,target=sys.argv[1:]
with tarfile.open(archive,'r:gz') as bundle:
 entries=bundle.getmembers()
 if len(entries)>100000 or sum(e.size for e in entries)>8*1024**3: raise RuntimeError('Runtime archive exceeds bounds')
 names=set()
 for entry in entries:
  path=pathlib.PurePosixPath(entry.name)
  if path.is_absolute() or '..' in path.parts or not path.parts or path.parts[0]!=target or entry.name in names: raise RuntimeError('Unsafe runtime archive path')
  if not(entry.isfile() or entry.isdir() or entry.issym() or entry.islnk()): raise RuntimeError('Unsafe runtime archive entry')
  names.add(entry.name)
 bundle.extractall(destination,filter='data')
`, archive, output, target], { stdio: "pipe", timeout: 300_000 });
  const { archiveSha256, ...expected } = metadata;
  if (canonical(verifyMacRuntime(join(output, target), metadata.sourceRevision, inputsDigest)) !== canonical(expected)) throw Error("Remote runtime archive metadata mismatch");
  return true;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  if (command === "package" && [4, 5].includes(args.length)) {
    const [providerPack, runnerBinary, sourceRevision, output, inputsDigest] = args;
    console.log(JSON.stringify(packageMacRuntime({ providerPack, runnerBinary, sourceRevision, output, inputsDigest })));
  } else if (command === "install" && [3, 4].includes(args.length)) {
    const [input, output, sourceRevision, inputsDigest] = args;
    console.log(JSON.stringify({ installed: installMacRuntime({ input, output, sourceRevision, inputsDigest: inputsDigest || undefined }) }));
  } else throw Error(`Usage: ${basename(process.argv[1])} package PACK RUNNER SOURCE OUTPUT | install INPUT OUTPUT SOURCE`);
}
