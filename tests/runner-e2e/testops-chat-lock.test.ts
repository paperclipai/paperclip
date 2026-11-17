import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { prepareChatBuildLock } from "./testops-chat-lock.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
async function fixture(source: "input" | "output" | "unknown") {
  const root = await mkdtemp(path.join(tmpdir(), "chat-reviewed-lock-"));
  const input = "reviewed input\n", output = "reviewed output\n";
  const patch = "diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml\n--- a/pnpm-lock.yaml\n+++ b/pnpm-lock.yaml\n@@ -1 +1 @@\n-reviewed input\n+reviewed output\n";
  await mkdir(path.join(root, "tests/runner-e2e"), { recursive: true });
  await writeFile(path.join(root, "package.json"), "{\"name\":\"synthetic-lock-owner\"}\n");
  await writeFile(path.join(root, "pnpm-lock.yaml"), source === "input" ? input : source === "output" ? output : "unreviewed source\n");
  await writeFile(path.join(root, "tests/runner-e2e/report-lock.patch"), patch);
  await writeFile(path.join(root, "tests/runner-e2e/report-lock.json"), JSON.stringify({ inputSha256: hash(input), outputSha256: hash(output), patchSha256: hash(patch) }));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "reviewed fixture"], { cwd: root });
  return { root, output };
}

it.each(["input", "output"] as const)("uses the existing reviewed %s lock without resolving dependencies", async source => {
  const f = await fixture(source);
  try {
    const receipt = await prepareChatBuildLock(f.root);
    expect(receipt.runtimeLockSha256).toBe(hash(f.output));
    expect(receipt.sourceInputsUnchanged).toBe(true);
    expect(await readFile(path.join(f.root, "pnpm-lock.yaml"), "utf8")).toBe(f.output);
    expect(await prepareChatBuildLock(f.root)).toEqual(receipt);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

it.each(["unknown-source", "unknown-runtime", "manifest", "patch", "policy"])("rejects %s drift before any installer or artifact", async variant => {
  const f = await fixture(variant === "unknown-source" ? "unknown" : "output");
  try {
    if (variant === "unknown-source") await writeFile(path.join(f.root, "pnpm-lock.yaml"), f.output);
    if (variant === "unknown-runtime") await writeFile(path.join(f.root, "pnpm-lock.yaml"), "unreviewed runtime\n");
    if (variant === "manifest") await writeFile(path.join(f.root, "package.json"), "{\"name\":\"unreviewed-graph\"}\n");
    if (variant === "patch") await writeFile(path.join(f.root, "tests/runner-e2e/report-lock.patch"), "unreviewed patch\n");
    if (variant === "policy") await writeFile(path.join(f.root, "tests/runner-e2e/report-lock.json"), "{}\n");
    await expect(prepareChatBuildLock(f.root)).rejects.toThrow();
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
