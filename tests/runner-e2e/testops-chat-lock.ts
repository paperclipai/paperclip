import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { prepareReportLock } from "./prepare-report-lock.mjs";

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const inputs = ["package.json", ":(glob)**/package.json", "pnpm-workspace.yaml", ".npmrc", ".pnpmfile.cjs",
  ":(glob)**/*.patch", "tests/runner-e2e/report-lock.json"];

export async function prepareChatBuildLock(root = path.resolve(import.meta.dirname, "../..")) {
  try {
    execFileSync("git", ["diff", "--quiet", "HEAD", "--", ...inputs], { cwd: root, stdio: "pipe" });
  } catch { throw new Error("Source dependency inputs changed before install or packaging"); }
  const committed = execFileSync("git", ["show", "HEAD:pnpm-lock.yaml"], { cwd: root });
  const policyBytes = await readFile(path.join(root, "tests/runner-e2e/report-lock.json"));
  const policy = JSON.parse(policyBytes.toString("utf8"));
  const sourceLockSha256 = hash(committed);
  if (![policy.inputSha256, policy.outputSha256].includes(sourceLockSha256))
    throw new Error("Committed dependency lock is not reviewed");
  await prepareReportLock(root);
  const runtimeLockSha256 = hash(await readFile(path.join(root, "pnpm-lock.yaml")));
  if (runtimeLockSha256 !== policy.outputSha256) throw new Error("Runtime dependency lock is not reviewed");
  return { sourceSha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    sourceLockSha256, runtimeLockSha256, policySha256: hash(policyBytes), sourceInputsUnchanged: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  prepareChatBuildLock().then(value => console.log(JSON.stringify(value)))
    .catch(() => { process.stderr.write("Chat TestOps dependency graph is not source-reviewed\n"); process.exitCode = 1; });
}
