import { expect, it } from "vitest";
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import YAML from "yaml";

const source = await readFile(new URL("../../.github/workflows/runner-full-stack-e2e.yml", import.meta.url), "utf8");
const steps = YAML.parse(source).jobs.test_manual_private.steps;
const prepare = steps.find((row: { id?: string }) => row.id === "provision_inputs");
const cleanup = steps.find((row: { name?: string }) => row.name === "Remove selected Pi installation input files");
const id = "chat-features.runner-opencode.local.instance-operations.provision-runtime";
function state() {
  return { needs: { catalog: { outputs: { operations_cadence: "" } } },
    steps: { manual_cell_route: { outputs: { route: "private" } }, manual_private_verified: { outcome: "success" } },
    matrix: { executionId: id, profileId: "runner-opencode", environmentId: "local" }, env: {} as Record<string, string> };
}
function condition(expression: string, context: ReturnType<typeof state>, previousStatus: "success" | "failure" | "cancelled" = "success") {
  const gated = /\b(?:always|cancelled|failure|success)\s*\(/.test(expression) ? expression : `success() && (${expression})`;
  return Function("needs", "steps", "matrix", "env", "always", "success", "failure", "cancelled", `return (${gated})`)(
    context.needs, context.steps, context.matrix, context.env, () => true,
    () => previousStatus === "success", () => previousStatus === "failure", () => previousStatus === "cancelled");
}
function run(step: { run: string }, env: NodeJS.ProcessEnv) {
  const body = step.run.split("<<'NODE'\n")[1]?.split("\nNODE")[0];
  if (!body) throw new Error("Actual workflow input producer missing");
  return spawnSync(process.execPath, ["--input-type=module", "-e", body], { encoding: "utf8", env: { PATH: process.env.PATH, ...env } });
}
const entries = (text: string) => Object.fromEntries(text.trim().split("\n").filter(Boolean).map(row => { const i = row.indexOf("="); return [row.slice(0, i), row.slice(i + 1)]; }));
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "provision-input-unit-"))), githubEnv = path.join(root, "env");
  await writeFile(githubEnv, "");
  return { root, githubEnv, env: { RUNNER_TEMP: root, GITHUB_ENV: githubEnv, SELECTED_EXECUTION_ID: id } };
}
it("selects only the exact private local provision cell after successful private preflight", () => {
  expect(prepare).toBeTruthy(); expect(condition(prepare.if, state())).toBe(true);
  for (const change of [
    (s: ReturnType<typeof state>) => { s.matrix.executionId = "chat-features.runner-opencode.local.onboarding.new-instance"; },
    (s: ReturnType<typeof state>) => { s.matrix.executionId += "-extra"; },
    (s: ReturnType<typeof state>) => { s.matrix.executionId = "instance-operations.provision-runtime"; },
    (s: ReturnType<typeof state>) => { s.matrix.executionId = id.replace("chat-features.", "other-suite."); },
    (s: ReturnType<typeof state>) => { s.matrix.profileId = "runner-codex"; },
    (s: ReturnType<typeof state>) => { s.matrix.environmentId = "daytona"; },
    (s: ReturnType<typeof state>) => { s.steps.manual_cell_route.outputs.route = "actions"; },
    (s: ReturnType<typeof state>) => { s.steps.manual_private_verified.outcome = "failure"; },
    (s: ReturnType<typeof state>) => { s.needs.catalog.outputs.operations_cadence = "daily"; },
  ]) { const wrong = state(); change(wrong); expect(condition(prepare.if, wrong)).toBe(false); }
  const verified = steps.find((row: { name?: string }) => row.name === "Verify restricted complete evidence storage before model or fixture secrets");
  const paid = steps.find((row: { name?: string }) => row.name === "Run paid cell");
  expect(steps.indexOf(verified)).toBeLessThan(steps.indexOf(prepare)); expect(steps.indexOf(prepare)).toBeLessThan(steps.indexOf(paid));
  expect(steps.indexOf(paid)).toBeLessThan(steps.indexOf(cleanup));
  expect(steps.indexOf(cleanup)).toBeLessThan(steps.findIndex((row: { name?: string }) => row.name === "Retain complete approved manual originals with no public fallback"));
  expect(Object.values(prepare.env).some(value => String(value).includes("secrets."))).toBe(false);
});
it.each(["failure", "cancelled"] as const)("actual cleanup remains eligible after %s, while missing always is rejected", status => {
  const failed = state(); failed.env.PAPERCLIP_PROVISION_INPUT_ROOT = "owned-root";
  expect(condition(cleanup.if, failed, status)).toBe(true);
  const missingAlways = cleanup.if.replace(/\balways\(\)\s*&&\s*/, "");
  expect(condition(missingAlways, failed, status)).toBe(false);
});
it("actual producer writes only the fixed published pin and named key reference in private owned files", async () => {
  const f = await fixture();
  try {
    const result = run(prepare, f.env); expect(result.status, result.stderr).toBe(0); expect(result.stdout).toBe("");
    const values = entries(await readFile(f.githubEnv, "utf8")), directory = values.PAPERCLIP_PROVISION_INPUT_ROOT!, file = values.PAPERCLIP_CHAT_INSTALLED_SOURCE_CONFIG!;
    expect(Object.keys(values).sort()).toEqual(["PAPERCLIP_CHAT_INSTALLED_SOURCE_CONFIG", "PAPERCLIP_PROVISION_INPUT_ROOT"]);
    expect(path.dirname(directory)).toBe(f.root); expect(path.dirname(file)).toBe(directory);
    expect((await stat(directory)).mode & 0o777).toBe(0o700); expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ schemaVersion: 1, disposable: true,
      source: { version: "2026.1023.0", integrity: "sha512-PA2gLYoJKcmen1YaNr7jtyyZK2xNyW92XEedgZ82S1MMeMEB2kdmk1okRMD4aFUV4OZPFBwk76pV0jCM2Fuy0g==" }, piCredentialEnv: "OPENROUTER_API_KEY" });
    const removed = run(cleanup, { ...f.env, ...values }); expect(removed.status, removed.stderr).toBe(0);
    await expect(access(directory)).rejects.toMatchObject({ code: "ENOENT" });
    expect(entries(await readFile(f.githubEnv, "utf8"))).toEqual({ PAPERCLIP_PROVISION_INPUT_ROOT: "", PAPERCLIP_CHAT_INSTALLED_SOURCE_CONFIG: "" });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
it("actual producer rejects a foreign selector before creating or handing off inputs", async () => {
  const f = await fixture();
  try {
    const result = run(prepare, { ...f.env, SELECTED_EXECUTION_ID: "chat-features.runner-opencode.local.onboarding.new-instance" });
    expect(result.status).toBe(1); expect(result.stdout).toBe(""); expect(await readdir(f.root)).toEqual(["env"]); expect(await readFile(f.githubEnv, "utf8")).toBe("");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
it("actual producer removes only its partial staging if environment handoff fails", async () => {
  const f = await fixture();
  try {
    const result = run(prepare, { ...f.env, GITHUB_ENV: f.root }); expect(result.status).toBe(1);
    expect(await readdir(f.root)).toEqual(["env"]); expect(result.stdout).toBe("");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
it("actual cleanup refuses foreign or linked staging without deleting it", async () => {
  const f = await fixture();
  try {
    const foreign = path.join(f.root, "unrelated"), link = path.join(f.root, "paperclip-provision-inputs-link"); await mkdir(foreign); await symlink(foreign, link);
    for (const root of [foreign, link]) expect(run(cleanup, { ...f.env, PAPERCLIP_PROVISION_INPUT_ROOT: root }).status).toBe(1);
    expect((await stat(foreign)).isDirectory()).toBe(true); expect(await readFile(f.githubEnv, "utf8")).toBe("");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
