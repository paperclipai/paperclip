import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createActionsReader, readSourceVerification, SourceVerificationFailed } from "./cloud-source-verification.mjs";

export async function selectCanarySource(candidates, verify) {
  for (const candidate of candidates.slice(0, 20)) {
    assert.match(candidate.sha ?? "", /^[a-f0-9]{40}$/);
    assert.equal(typeof candidate.published, "boolean");
    if (candidate.published) return undefined;
    try {
      const proof = await verify(candidate.sha);
      if (proof) {
        assert.equal(proof.sha, candidate.sha);
        return candidate.sha;
      }
    } catch (error) {
      if (!(error instanceof SourceVerificationFailed)) throw error;
    }
  }
  return undefined;
}

export function canaryCandidates(source, git = args => execFileSync("git", args, { encoding: "utf8" })) {
  assert.match(source ?? "", /^[a-f0-9]{40}$/);
  return git(["log", "--first-parent", "--max-count=20", "--decorate=full", "--format=%H %D", source])
    .trim().split("\n").filter(Boolean).map(line => ({
      sha: line.slice(0, 40),
      published: /(?:^|, )tag: refs\/tags\/canary\/v[^,\s]+(?:,|$)/.test(line.slice(41)),
    }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.ok(process.env.GITHUB_TOKEN, "GITHUB_TOKEN with Actions read access is required.");
  const deadline = Date.now() + 2 * 60_000;
  const api = createActionsReader({ token: process.env.GITHUB_TOKEN, deadlineAt: () => deadline });
  const master = execFileSync("git", ["rev-parse", "refs/remotes/origin/master"], { encoding: "utf8" }).trim();
  const sha = await selectCanarySource(canaryCandidates(master), source => {
    assert.ok(Date.now() < deadline, "Canary selection exceeded its read budget.");
    return readSourceVerification(source, api);
  });
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `proceed=${Boolean(sha)}\nsha=${sha ?? ""}\n`);
  const summary = sha
    ? `Selected the newest verified unpublished master source: ${sha}.`
    : "Canary skipped: no newer verified unpublished source among the latest 20 master commits.";
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
}
