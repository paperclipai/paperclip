import { createHash } from "node:crypto";
import { lstat, readFile, readdir, readlink } from "node:fs/promises";
import path from "node:path";
import type { RunnerProfileFixture } from "./types.js";

export const NATIVE_COMPLETION_BUDGET_CENTS = 1_000;
// Independent, immutable current-master default; not the reduced #14948 manual.
export const NATIVE_MASTER_DEFAULT_SHA256 = "e4d2375d722602cd744403292d99f6e6c9b7e8014d9cdfa6f9811ace03428e5f";

/** Scoped blocker proof: hash symlink identity without following any target. */
export async function nativeCompletionWorkspaceDigest(root: string): Promise<string> {
  const hash = createHash("sha256");
  async function visit(relative: string) {
    const entries = await readdir(path.join(root, relative), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(relative, entry.name), absolute = path.join(root, file), stat = await lstat(absolute);
      hash.update(JSON.stringify([file, stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other"]));
      if (stat.isSymbolicLink()) hash.update(await readlink(absolute));
      else if (stat.isDirectory()) await visit(file);
      else if (stat.isFile()) hash.update(await readFile(absolute));
    }
  }
  await visit(""); return hash.digest("hex");
}

export function nativeCompletionProfile(profile: RunnerProfileFixture): RunnerProfileFixture {
  if (profile.generation !== "native") throw new Error("Native completion requires a native profile");
  return { ...profile, buildAgent(input) {
    const { instructionsBundle: _fixtureBundle, ...agent } = profile.buildAgent(input);
    return { ...agent, budgetMonthlyCents: NATIVE_COMPLETION_BUDGET_CENTS };
  } };
}

export interface NativeDefaultReceipt {
  schema: "paperclip.native-completion-default.v1";
  agentId: string;
  companyId: string;
  entryFile: unknown;
  files: Array<{ path: string; sha256: string; bytes: number }>;
  budgets: { company: unknown; agent: unknown };
}

export function gradeNativeDefault(receipt: NativeDefaultReceipt, expectedDefaultSha256 = NATIVE_MASTER_DEFAULT_SHA256) {
  const checks = [
    { id: "production-default-bundle", passed: receipt.entryFile === "AGENTS.md"
      && receipt.files.length === 1 && receipt.files[0]?.path === "AGENTS.md"
      && receipt.files[0]?.sha256 === expectedDefaultSha256,
    detail: "The served public hire bundle matches the declared production default, with no fixture instruction injection." },
    { id: "bounded-company-and-agent", passed: receipt.budgets.company === NATIVE_COMPLETION_BUDGET_CENTS
      && receipt.budgets.agent === NATIVE_COMPLETION_BUDGET_CENTS,
    detail: "Both public budgets enforce the declared 1,000-cent hard stop." },
  ];
  return { passed: checks.every(check => check.passed), checks };
}

export async function captureNativeDefault(input: {
  api: { get<T>(path: string): Promise<T> }; agentId: string; companyId: string;
}): Promise<NativeDefaultReceipt> {
  const [bundle, company, agent] = await Promise.all([
    input.api.get<{ entryFile: unknown; files: Array<{ path: string }> }>(`/api/agents/${input.agentId}/instructions-bundle`),
    input.api.get<{ budgetMonthlyCents: unknown }>(`/api/companies/${input.companyId}`),
    input.api.get<{ budgetMonthlyCents: unknown }>(`/api/agents/${input.agentId}`),
  ]);
  const files = await Promise.all(bundle.files.map(async file => {
    const detail = await input.api.get<{ content: string }>(`/api/agents/${input.agentId}/instructions-bundle/file?path=${encodeURIComponent(file.path)}`);
    return { path: file.path, sha256: createHash("sha256").update(detail.content).digest("hex"), bytes: Buffer.byteLength(detail.content) };
  }));
  return { schema: "paperclip.native-completion-default.v1", agentId: input.agentId, companyId: input.companyId,
    entryFile: bundle.entryFile, files, budgets: { company: company.budgetMonthlyCents, agent: agent.budgetMonthlyCents } };
}
