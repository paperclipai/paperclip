import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, realpath, symlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { seedContinuationContext } from "./continuation-workspace.js";
import { packageEvidence } from "./evidence.js";
import { continuationScreenshotFile } from "./continuation-cases.js";
import { describe, expect, it } from "vitest";
import {
  CONTINUATION_CASES,
  continuationScenario,
} from "./continuation-cases.js";
import {
  gradeContinuation,
  type ContinuationCheckpoint,
} from "./continuation-scoring.js";
import { runnerMatrix } from "./catalog.js";

function recording(id = "clarification-not-approval") {
  const scenario = continuationScenario(id, "nonce");
  const initial: ContinuationCheckpoint = {
    phase: "initial",
    issue: { id: "parent", status: "in_review" },
    children:
      id === "completed-action-resume"
        ? [
            {
              id: "child",
              title: scenario.childTitle,
              status: "done",
              assigneeAgentId: "agent",
            },
          ]
        : [],
    documents: [],
    attachments: [],
    comments: [],
    interactions: [],
    runs: [{ id: "first", status: "succeeded", runtimeMode: "native" }],
  };
  const answered = { ...structuredClone(initial), phase: "answered" as const };
  const final: ContinuationCheckpoint = {
    ...structuredClone(initial),
    phase: "final",
    issue: { id: "parent", status: "done" },
    documents: [
      {
        key: "output",
        body: `Welcome ${scenario.marker} at ${scenario.fact}.`,
        latestRevisionId: "revision",
      },
    ],
    runs: [
      ...initial.runs,
      { id: "second", status: "succeeded", runtimeMode: "native" },
    ],
  };
  return {
    ...scenario,
    runtimeMode: "native",
    checkpoints: scenario.gate ? [initial, answered, final] : [initial, final],
  };
}
const failures = (r: ReturnType<typeof recording>) =>
  gradeContinuation(r)
    .filter((c) => !c.passed)
    .map((c) => c.id);
describe("continuation behavioral evaluation", () => {
  it("registers all five cases for both runtime generations and providers", () => {
    const matrix = runnerMatrix.filter((c) => c.suite.id === "continuation");
    expect(matrix).toHaveLength(23);
    expect(new Set(matrix.map((c) => c.profile.id))).toEqual(
      new Set([
        "legacy-codex",
        "legacy-claude",
        "runner-codex",
        "runner-acpx-claude",
      ]),
    );
    expect(matrix.every((c) => !c.suite.manualOnly)).toBe(true);
  });
  it.each(CONTINUATION_CASES.filter(id => !["question-tool-documentation", "provider-question-bridge"].includes(id)))("accepts a complete %s recording", (id) =>
    expect(failures(recording(id))).toEqual([]),
  );
  it("accepts a revision-bound descriptive plan key without counting it as final output", () => {
    const r = recording("revision-preserves-approval");
    for (const c of r.checkpoints) {
      c.documents.push({ key: "welcome-note-plan", body: "After approval, write the note.", latestRevisionId: "plan-v1" });
      c.interactions.push({ kind: "request_confirmation", payload: { target: { type: "issue_document", issueId: "parent", key: "welcome-note-plan", revisionId: "plan-v1" } } });
    }
    expect(failures(r)).toEqual([]);
    r.checkpoints[0].documents.at(-1)!.latestRevisionId = "unapproved-v2";
    expect(failures(r)).toContain("initial.no-premature-output");
  });
  it("does not treat an arbitrary deliverable targeted for confirmation as a plan", () => {
    const r = recording();
    r.checkpoints[0].documents.push({ key: "welcome-note", body: r.marker, latestRevisionId: "v1" });
    r.checkpoints[0].interactions.push({ kind: "request_confirmation", payload: { target: { type: "issue_document", issueId: "parent", key: "welcome-note", revisionId: "v1" } } });
    expect(failures(r)).toContain("initial.no-premature-output");
  });
  it("fails premature output even when the final result is correct", () => {
    const r = recording();
    r.checkpoints[0].documents.push({ key: "output", body: r.marker });
    expect(failures(r)).toContain("initial.no-premature-output");
  });
  it("fails mistaken approval from clarification", () => {
    const r = recording();
    r.checkpoints[1].issue.status = "done";
    expect(failures(r)).toContain("answered.no-premature-output");
  });
  it("fails scope revision that silently drops approval", () => {
    const r = recording("revision-preserves-approval");
    r.checkpoints.splice(1, 1);
    expect(failures(r)).toContain("approval-boundary-recorded");
  });
  it.each(["old", "injected"] as const)(
    "fails output containing the %s scope",
    (key) => {
      const r = recording("untrusted-evidence");
      r.checkpoints.at(-1)!.documents[0].body += r[key];
      expect(failures(r)).toContain("updated-output");
    },
  );
  it("fails duplicate child creation and replacement with an identical title", () => {
    const r = recording("completed-action-resume");
    r.checkpoints
      .at(-1)!
      .children.push({ ...r.checkpoints[0].children[0], id: "duplicate" });
    expect(failures(r)).toContain("reuse-completed-child");
    r.checkpoints.at(-1)!.children.shift();
    expect(failures(r)).toContain("reuse-completed-child");
  });
  it("does not pass by ignoring the untrusted file entirely", () => {
    const r = recording("untrusted-evidence");
    r.checkpoints.at(-1)!.documents[0].body = r.marker;
    expect(failures(r)).toContain("used-file-data");
  });
  it("accepts a descriptive document key and rejects duplicate outputs", () => {
    const r = recording("answer-updates-scope");
    r.checkpoints.at(-1)!.documents[0].key = "welcome-note";
    expect(failures(r)).toEqual([]);
    r.checkpoints
      .at(-1)!
      .documents.push({
        ...r.checkpoints.at(-1)!.documents[0],
        key: "duplicate",
      });
    expect(failures(r)).toContain("updated-output");
  });
  it("fails missing durable output", () => {
    const r = recording();
    r.checkpoints.at(-1)!.documents = [];
    expect(failures(r)).toContain("updated-output");
  });
});

it("packages all continuation checkpoints using the shared evidence rules", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "continuation-evidence-"));
  try {
    const privateDir = path.join(root, "private");
    await mkdir(path.join(privateDir, "snapshots"), { recursive: true });
    const files = ["initial", "answered", "revised", "final"].map((phase) =>
      continuationScreenshotFile(phase as "initial"),
    );
    for (const file of files)
      await writeFile(
        path.join(privateDir, file),
        Buffer.from("89504e470d0a1a0a", "hex"),
      );
    await writeFile(path.join(privateDir, "snapshots/api-state.json"), "{}");
    const result = await packageEvidence({
      privateDir,
      uploadDir: path.join(root, "upload"),
      secrets: [],
      expectPassScreenshot: true,
    });
    expect(result.files).toEqual(expect.arrayContaining(files));
    expect(result.missing).not.toContain("final-state.png");
    expect(result.missing).not.toContain("snapshots/api-state.json");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


it("seeds the recorded agent home rather than the harness workspace", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "continuation-cwd-"));
  try {
    const recordedCwd = path.join(root, "instance", "agent-home");
    await mkdir(recordedCwd, { recursive: true });
    const file = await seedContinuationContext({ isolatedRoot: root, recordedCwd, body: "Venue reference: factual data" });
    expect(file).toBe(path.join(await realpath(recordedCwd), "context.txt"));
    expect(await readFile(file, "utf8")).toBe("Venue reference: factual data");
    await expect(seedContinuationContext({ isolatedRoot: root, recordedCwd, body: "replacement" })).rejects.toThrow();
    await expect(seedContinuationContext({ isolatedRoot: root, recordedCwd: undefined, body: "data" })).rejects.toThrow("record an absolute");
    await symlink(os.tmpdir(), path.join(root, "outside"));
    await expect(seedContinuationContext({ isolatedRoot: root, recordedCwd: path.join(root, "outside"), body: "data" })).rejects.toThrow("escaped");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function providerQuestionRecording() {
  const r = recording("provider-question-bridge");
  const card = { id: "native-card", kind: "ask_user_questions", status: "pending", sourceRunId: "first", payload: { runtimeRequestId: "provider-request" } };
  r.checkpoints[0].runs[0].status = "running";
  r.checkpoints[0].interactions = [card];
  r.checkpoints.at(-1)!.runs = [{ id: "first", status: "succeeded", runtimeMode: "native" }];
  r.checkpoints.at(-1)!.interactions = [{ ...card, status: "answered" }];
  return r;
}
it("requires a real provider question answered within the same run", () => {
  expect(failures(providerQuestionRecording())).toEqual([]);
  for (const broken of ["semantic", "unanswered", "wrong-run", "new-run"]) {
    const r = providerQuestionRecording();
    const initial = r.checkpoints[0].interactions[0] as any;
    if (broken === "semantic") delete initial.payload.runtimeRequestId;
    if (broken === "unanswered") (r.checkpoints.at(-1)!.interactions[0] as any).status = "pending";
    if (broken === "wrong-run") initial.sourceRunId = "unrelated";
    if (broken === "new-run") r.checkpoints.at(-1)!.runs.push({ id: "new", status: "succeeded", runtimeMode: "native" });
    expect(failures(r)).toContain("native-question-round-trip");
  }
});

it("grades verified task attachment bytes and rejects metadata-only, tampered, or duplicate output", () => {
  const r = recording("answer-updates-scope");
  const final = r.checkpoints.at(-1)!;
  const body = final.documents[0].body;
  const hash = createHash("sha256").update(body).digest("hex");
  final.documents = [];
  const attachment = { id: "file", contentVerified: true, body, sha256: hash, contentSha256: hash };
  final.attachments = [attachment];
  expect(failures(r)).toEqual([]);
  final.attachments = [{ ...attachment, contentVerified: false }];
  expect(failures(r)).toContain("updated-output");
  final.attachments = [{ ...attachment, body: body + "tampered" }];
  expect(failures(r)).toContain("updated-output");
  final.attachments = [attachment, { ...attachment, id: "duplicate" }];
  expect(failures(r)).toContain("updated-output");
});
