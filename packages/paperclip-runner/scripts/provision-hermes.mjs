import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const provider = await access(join(root, "src/providers/hermes/version.json")).then(() => join(root, "src/providers/hermes"), () => join(root, "dist/providers/hermes"));
const version = JSON.parse(await readFile(join(provider, "version.json"), "utf8"));
const destination = process.argv[2];
if (!destination || !isAbsolute(destination)) throw new Error("Hermes provisioning requires a new absolute destination");
if (!["darwin-arm64", "linux-x64"].includes(`${process.platform}-${process.arch}`)) throw new Error("Hermes platform is not a qualification target");
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const temporary = await mkdtemp(join(tmpdir(), "paperclip-hermes-provision-"));
try {
  const uvVersion = execFileSync("uv", ["--version"], { encoding: "utf8" });
  if (!/^uv 0\.12\.17(?:\s|$)/.test(uvVersion)) throw new Error("Hermes provisioning requires uv 0.12.17; install that version before provisioning");
  const response = await fetch(`https://api.github.com/repos/NousResearch/hermes-agent/tarball/${version.commit}`, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Hermes source download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (digest(bytes) !== version.archiveSha256) throw new Error("Hermes source digest mismatch");
  const archive = join(temporary, "source.tar.gz");
  await writeFile(archive, bytes, { mode: 0o600, flag: "wx" });
  execFileSync("tar", ["-xzf", archive, "--strip-components=1", "-C", temporary]);
  await rm(archive);
  if (digest(await readFile(join(temporary, "uv.lock"))) !== version.lockSha256) throw new Error("Hermes dependency lock digest mismatch");
  execFileSync("uv", ["sync", "--locked", "--no-dev", "--no-install-project", "--python", version.python,
    "--extra", "acp", "--extra", "mcp", "--extra", "anthropic", "--extra", "bedrock", "--extra", "google"], { cwd: temporary, stdio: "inherit" });
  execFileSync(join(temporary, ".venv/bin/python"), [join(root, "scripts/materialize-hermes.py"), temporary, destination, provider], { stdio: "inherit" });
} finally { await rm(temporary, { recursive: true, force: true }); }
