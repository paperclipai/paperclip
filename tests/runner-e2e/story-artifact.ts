import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
import type { StoryCheck } from "./everyday-observations.js";

/** Runs only the maintained independent oracle, with no provider credentials. */
export async function runArtifactOracle(file: string | null, mode: "base" | "separator" | "max-length", deadlineAt: number) {
  const args = [path.join(import.meta.dirname, "everyday-artifact.py"), ...(file ? [file, "--mode", mode] : ["--preflight"])];
  const output = await new Promise<string>((resolve, reject) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => ["PATH", "SYSTEMROOT", "TMPDIR", "DOCKER_HOST", "DOCKER_CONTEXT", "HOME"].includes(key)));
    const child = spawn(process.env.PYTHON ?? "python3", args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", exceeded = false;
    const timer = setTimeout(() => child.kill("SIGKILL"), Math.max(1, Math.min(90_000, deadlineAt - Date.now())));
    child.stdout.on("data", chunk => { stdout += String(chunk); if (stdout.length > 1_000_000) { exceeded = true; child.kill("SIGKILL"); } });
    child.stderr.resume();
    child.once("error", () => { clearTimeout(timer); reject(new Error("artifact_oracle_unavailable")); });
    child.once("exit", code => { clearTimeout(timer); code === 0 && !exceeded ? resolve(stdout) : reject(new Error("artifact_oracle_failed")); });
  });
  if (!file) return [];
  const value = JSON.parse(output) as { checks: StoryCheck[] };
  if (!Array.isArray(value.checks) || !value.checks.length || value.checks.some(check => typeof check.passed !== "boolean")) throw new Error("artifact_oracle_receipt_invalid");
  return value.checks;
}

/** Download through the visible task control; attachment metadata is not a content oracle. */
export async function downloadStoryArtifact(input: {
  page: Page; attachmentId: string; directory: string; phase: string;
  mode: "base" | "separator" | "max-length"; deadlineAt: number;
}) {
  const link = input.page.locator(`a[href*="/api/attachments/${input.attachmentId}/content"]`).filter({ hasText: /Download/i }).first();
  await expect(link).toBeVisible({ timeout: 30_000 });
  const [download] = await Promise.all([input.page.waitForEvent("download", { timeout: 30_000 }), link.click()]);
  await mkdir(input.directory, { recursive: true, mode: 0o700 });
  const file = path.join(input.directory, `${input.phase}.zip`);
  await download.saveAs(file);
  const bytes = await readFile(file);
  const checks = await runArtifactOracle(file, input.mode, input.deadlineAt);
  return { attachmentId: input.attachmentId, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length,
    filename: download.suggestedFilename(), checks };
}
