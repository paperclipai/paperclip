import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { IssueAttachment } from "../../packages/shared/src/types/issue.js";
import type { RunnerApi } from "./api.js";
const exec = promisify(execFile);
/** Test-owned repository only; the source checkout is never part of this fixture. */
export async function prepareOpenAiHostedFixture(workspace: string) {
  if ((await readdir(workspace)).length !== 0) throw new Error("OpenAI fixture requires an empty disposable workspace");
  const source = path.join(path.dirname(workspace), "openai-fixture-source");
  await mkdir(source, { recursive: false });
  await exec("git", ["init", "-q", source]);
  await writeFile(path.join(source, "seed.txt"), "OpenAI hosted fixture baseline\n");
  await exec("git", ["-C", source, "add", "seed.txt"]);
  await exec("git", ["-C", source, "-c", "user.name=Runner E2E", "-c", "user.email=runner@example.invalid", "commit", "-qm", "Fixture baseline"]);
  await rmdir(workspace);
  await exec("git", ["-C", source, "worktree", "add", "--detach", workspace, "HEAD"]);
}

/** Prove the hosted export is persisted and downloadable through the user API. */
export async function readOpenAiHostedArtifact(api: RunnerApi, issueId: string, runId: string) {
  const attachments = await api.get<IssueAttachment[]>(`/api/issues/${issueId}/attachments`);
  const matches = attachments.filter((entry) => entry.issueId === issueId && entry.originatingRunId === runId && entry.originalFilename === "paperclip-workspace.json");
  if (matches.length !== 1) throw new Error(`Expected one hosted workspace attachment from the tested run; observed ${matches.length}`);
  const attachment = matches[0]!;
  const response = await api.request.get(`/api/attachments/${encodeURIComponent(attachment.id)}/content?download=1`);
  if (!response.ok()) throw new Error(`Hosted export download returned ${response.status()}`);
  const bytes = await response.body();
  if (bytes.length !== attachment.byteSize || createHash("sha256").update(bytes).digest("hex") !== attachment.sha256) throw new Error("Hosted export download disagrees with persisted attachment bytes");
  const exported = JSON.parse(bytes.toString("utf8"));
  if (exported.schema !== "paperclip.openai-workspace-export.v1" || !Array.isArray(exported.entries)) throw new Error("Hosted export download has an invalid schema");
  return { attachmentId: attachment.id, name: attachment.originalFilename!, mimeType: attachment.contentType, sha256: attachment.sha256, byteSize: bytes.length };
}
