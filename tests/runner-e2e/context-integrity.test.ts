import { describe, expect, it } from "vitest";
import { contextIntegrityScenario } from "./context-integrity-cases.js";
import { gradeContextIntegrity } from "./context-integrity-scoring.js";
import { runnerMatrix } from "./catalog.js";

function recording(id: "ordered-comment-continuation" | "assigned-skill-explicit-invocation", valid = true) {
  const scenario = contextIntegrityScenario(id, "nonce");
  const initial = {
    phase: "initial" as const,
    issue: { id: "issue", status: "in_progress" },
    comments: [],
    documents: id === "ordered-comment-continuation" ? [{ key: "packing-report", body: "passport\ncharger" }] : [],
    runs: [{ id: "run-1", status: "running" }],
    ...(id === "assigned-skill-explicit-invocation" ? {
      assignedSkill: { key: scenario.skillKey, runtimeName: scenario.skillKey, versionId: "version-1", markdown: `write ${scenario.marker}` },
      skillRequestText: `${scenario.prompt}\n\nUse /${scenario.skillKey} for this request.`,
      skillInvocationEvidence: valid,
    } : {}),
  };
  const final = {
    ...initial,
    phase: "final" as const,
    issue: { id: "issue", status: "done" },
    comments: scenario.comments.map((body, index) => ({ body, authorType: "user", id: `comment-${index}` })),
    documents: [{ key: "output", body: id === "ordered-comment-continuation" ? `passport\ncharger\n## Ordered request ledger\n${scenario.comments.join("\n")}\n## Final scope\nLaunch checklist` : `Final ${scenario.marker}` }],
    runs: [{ id: "run-1", status: "succeeded", startedAt: "2026-01-01T00:00:00Z" }, { id: "run-2", status: "succeeded", startedAt: "2026-01-01T00:01:00Z", contextSnapshot: { paperclipWake: { commentIds: ["comment-0", "comment-1", "comment-2"] } } }],
  };
  const queued = {
    ...initial,
    phase: "comment-3" as const,
    queuedComments: { entries: scenario.comments.map((body, index) => ({ comment: { body, id: `comment-${index}` } })) },
  };
  return { scenario, checkpoints: id === "ordered-comment-continuation" ? [initial, queued, final] : [initial, final] };
}

describe("context integrity Product E2E contract", () => {
  it("is explicit-only and covers the selected legacy/native profiles", () => {
    const cells = runnerMatrix.filter((execution) => execution.suite.id === "context-integrity");
    expect(cells).toHaveLength(20);
    expect(new Set(cells.map((execution) => execution.profile.id))).toEqual(new Set([
      "legacy-codex", "legacy-claude", "legacy-acp-codex", "legacy-acp-claude", "legacy-kimi-cli", "legacy-kimi-acp", "legacy-grok", "runner-codex", "runner-opencode", "runner-acpx-claude",
    ]));
    expect(cells.every((execution) => execution.suite.manualOnly)).toBe(true);
    expect(runnerMatrix.filter((execution) => execution.suite.id === "context-integrity" && execution.suite.manualOnly).every((execution) => !execution.suite.groups.includes("core"))).toBe(true);
  });

  it("does not reveal the future scope in the initial request", () => {
    const scenario = contextIntegrityScenario("ordered-comment-continuation", "nonce");
    expect(scenario.prompt.toLowerCase()).not.toContain("launch checklist");
    expect(scenario.comments[2]).toContain("launch checklist");
  });

  it("grades applied scope separately from a quoted direction in either section order", () => {
    const { scenario, checkpoints } = recording("ordered-comment-continuation");
    for (const ledgerFirst of [true, false]) {
      const ledger = `## Ordered request ledger\n${scenario.comments.join("\n")}`;
      for (const [scope, expected] of [["Launch checklist", true], ["Passport and charger", false]] as const) {
        const finalScope = `## Final scope\n${scope}`;
        const sections = ledgerFirst ? [ledger, finalScope] : [finalScope, ledger];
        const candidate = structuredClone(checkpoints);
        candidate[2]!.documents[0]!.body = `passport\ncharger\n${sections.join("\n\n")}`;
        expect(gradeContextIntegrity({ id: scenario.id, marker: scenario.marker, comments: scenario.comments, checkpoints: candidate }))
          .toEqual(expect.arrayContaining([expect.objectContaining({ id: "final-scope-applied", passed: expected })]));
      }
    }
  });

  it("accepts the saved article-style final scope heading", () => {
    const { scenario, checkpoints } = recording("ordered-comment-continuation");
    const article = structuredClone(checkpoints);
    (article[2].documents[0] as { body: string }).body =
      (article[2].documents[0] as { body: string }).body.replace(
        "## Final scope\nLaunch checklist",
        "## Final scope\nthe launch checklist",
      );
    expect(
      gradeContextIntegrity({
        id: scenario.id,
        marker: scenario.marker,
        comments: scenario.comments,
        checkpoints: article,
      }),
    ).toEqual(expect.arrayContaining([expect.objectContaining({ id: "final-scope-applied", passed: true })]));
  });

  it("requires distinct ordered comments, including intentional repetition", () => {
    const { scenario, checkpoints } = recording("ordered-comment-continuation");
    expect(gradeContextIntegrity({ id: scenario.id, marker: scenario.marker, comments: scenario.comments, checkpoints }).every((check) => check.passed)).toBe(true);
    const normalCaps = structuredClone(checkpoints);
    (normalCaps[2].documents[0] as { body: string }).body = `# Packing List\n\n- Passport\n- Charger\n\n## Ordered request ledger\n${scenario.comments.join("\n")}\n\n## Final scope\nLaunch checklist`;
    expect(gradeContextIntegrity({ id: scenario.id, marker: scenario.marker, comments: scenario.comments, checkpoints: normalCaps }).every((check) => check.passed)).toBe(true);
    const wrong = structuredClone(checkpoints);
    (wrong[2].comments[1] as { body: string }).body = String(scenario.changed);
    expect(gradeContextIntegrity({ id: scenario.id, marker: scenario.marker, comments: scenario.comments, checkpoints: wrong })).toEqual(expect.arrayContaining([expect.objectContaining({ id: "ordered-comments", passed: false })]));
    const echoed = structuredClone(checkpoints);
    (echoed[2].documents[0] as { body: string }).body = `passport\ncharger\n${scenario.comments[2]}\n${scenario.comments[0]}\n${scenario.comments[1]}`;
    expect(gradeContextIntegrity({ id: scenario.id, marker: scenario.marker, comments: scenario.comments, checkpoints: echoed })).toEqual(expect.arrayContaining([expect.objectContaining({ id: "packing-report-order", passed: false })]));
    const missingQueue = structuredClone(checkpoints);
    const queuedEntries = (missingQueue[1] as { queuedComments?: { entries?: unknown[] } }).queuedComments?.entries ?? [];
    (missingQueue[1] as { queuedComments?: { entries: unknown[] } }).queuedComments = { entries: queuedEntries.slice(0, 2) };
    expect(gradeContextIntegrity({ id: scenario.id, marker: scenario.marker, comments: scenario.comments, checkpoints: missingQueue })).toEqual(expect.arrayContaining([expect.objectContaining({ id: "comments-queued-as-batch", passed: false })]));
    const missingInitialItem = structuredClone(checkpoints);
    (missingInitialItem[2].documents[0] as { body: string }).body = `passport\n${scenario.comments.join("\n")}`;
    expect(gradeContextIntegrity({ id: scenario.id, marker: scenario.marker, comments: scenario.comments, checkpoints: missingInitialItem })).toEqual(expect.arrayContaining([expect.objectContaining({ id: "packing-report-order", passed: false })]));
    const missingSecondRun = structuredClone(checkpoints);
    missingSecondRun[2].runs = [{ id: "run-1", status: "succeeded" }];
    expect(gradeContextIntegrity({ id: scenario.id, marker: scenario.marker, comments: scenario.comments, checkpoints: missingSecondRun })).toEqual(expect.arrayContaining([expect.objectContaining({ id: "continuation-run-count", passed: false })]));
    const unchangedScope = structuredClone(checkpoints);
    (unchangedScope[2].documents[0] as { body: string }).body = `passport\ncharger\n## Ordered request ledger\n${scenario.comments.join("\n")}\n## Final scope\nPassport and charger`;
    expect(gradeContextIntegrity({ id: scenario.id, marker: scenario.marker, comments: scenario.comments, checkpoints: unchangedScope })).toEqual(expect.arrayContaining([expect.objectContaining({ id: "final-scope-applied", passed: false })]));
    const missingScope = structuredClone(checkpoints);
    (missingScope[2].documents[0] as { body: string }).body = `passport\ncharger\n${scenario.comments.join("\n")}\n${scenario.marker}`;
    expect(gradeContextIntegrity({ id: scenario.id, marker: scenario.marker, comments: scenario.comments, checkpoints: missingScope })).toEqual(expect.arrayContaining([expect.objectContaining({ id: "final-scope-applied", passed: false })]));
    const fragmentedWake = structuredClone(checkpoints);
    (fragmentedWake[2].runs[1] as { contextSnapshot: { paperclipWake: { commentIds: string[] } } }).contextSnapshot.paperclipWake.commentIds = ["comment-0", "comment-2"];
    expect(gradeContextIntegrity({ id: scenario.id, marker: scenario.marker, comments: scenario.comments, checkpoints: fragmentedWake })).toEqual(expect.arrayContaining([expect.objectContaining({ id: "continuation-wake-comment-ids", passed: false })]));
  });

  it("ignores run-authored comments and rejects duplicate durable comment identities", () => {
    const { scenario, checkpoints } = recording("ordered-comment-continuation");
    const forged = structuredClone(checkpoints);
    (forged[2].comments as Array<Record<string, unknown>>).unshift({ body: scenario.comments[2], authorType: "user", authorUserId: "human", createdByRunId: "run-1", id: "run-comment" });
    expect(gradeContextIntegrity({ id: scenario.id, marker: scenario.marker, comments: scenario.comments, checkpoints: forged }).every((check) => check.passed)).toBe(true);
    const duplicate = structuredClone(checkpoints);
    (duplicate[2].comments[1] as { id: string }).id = "comment-0";
    expect(gradeContextIntegrity({ id: scenario.id, marker: scenario.marker, comments: scenario.comments, checkpoints: duplicate })).toEqual(expect.arrayContaining([expect.objectContaining({ id: "distinct-comment-identities", passed: false })]));
  });

  it("accepts implicit native skill loading when public assignment and output provenance are valid", () => {
    const { scenario, checkpoints } = recording("assigned-skill-explicit-invocation", false);
    expect(gradeContextIntegrity({ id: scenario.id, marker: scenario.marker, comments: scenario.comments, checkpoints }).every((check) => check.passed)).toBe(true);
  });

  it("rejects missing assignment, missing marker, leaked marker, and non-explicit skill names", () => {
    const { scenario, checkpoints } = recording("assigned-skill-explicit-invocation", false);
    const missingAssignment = structuredClone(checkpoints);
    (missingAssignment[0].assignedSkill as { versionId: string | null }).versionId = null;
    expect(gradeContextIntegrity({ id: scenario.id, marker: scenario.marker, comments: scenario.comments, checkpoints: missingAssignment })).toEqual(expect.arrayContaining([expect.objectContaining({ id: "assigned-skill-present", passed: false })]));
    const missingMarker = structuredClone(checkpoints);
    (missingMarker[1].documents[0] as { body: string }).body = "Final report without provenance";
    expect(gradeContextIntegrity({ id: scenario.id, marker: scenario.marker, comments: scenario.comments, checkpoints: missingMarker })).toEqual(expect.arrayContaining([expect.objectContaining({ id: "single-durable-output", passed: false })]));
    const leakedMarker = structuredClone(checkpoints);
    leakedMarker[0].skillRequestText = `${scenario.prompt} ${scenario.marker} /${scenario.skillKey}`;
    expect(gradeContextIntegrity({ id: scenario.id, marker: scenario.marker, comments: scenario.comments, checkpoints: leakedMarker })).toEqual(expect.arrayContaining([expect.objectContaining({ id: "marker-not-in-request", passed: false })]));
    const missingExplicitName = structuredClone(checkpoints);
    missingExplicitName[0].skillRequestText = scenario.prompt;
    expect(gradeContextIntegrity({ id: scenario.id, marker: scenario.marker, comments: scenario.comments, checkpoints: missingExplicitName })).toEqual(expect.arrayContaining([expect.objectContaining({ id: "skill-request-explicit", passed: false })]));
    const wrongPrefix = structuredClone(checkpoints);
    wrongPrefix[0].skillRequestText = `${scenario.prompt} Use ${scenario.skillKey} for this request.`;
    expect(gradeContextIntegrity({ id: scenario.id, marker: scenario.marker, comments: scenario.comments, checkpoints: wrongPrefix })).toEqual(expect.arrayContaining([expect.objectContaining({ id: "skill-request-explicit", passed: false })]));
    const missingSourceMarker = structuredClone(checkpoints);
    (missingSourceMarker[0].assignedSkill as { markdown: string }).markdown = "---\nname: skill\n---\nNo output marker.";
    expect(gradeContextIntegrity({ id: scenario.id, marker: scenario.marker, comments: scenario.comments, checkpoints: missingSourceMarker })).toEqual(expect.arrayContaining([expect.objectContaining({ id: "skill-source-marker", passed: false })]));
  });
});
