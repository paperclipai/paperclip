import { describe, expect, it } from "vitest";
import type {
  CompanySkillLastEditor,
  CompanySkillListItem,
  CompanySkillTestRunStatus,
  CompanySkillTestRunTemplate,
  IssueAttachment,
  IssueDocument,
  IssueWorkProduct,
} from "@paperclipai/shared";
import {
  buildReRunRequest,
  buildCreateRunRequest,
  DEFAULT_TEST_RUN_TEMPLATE_ID,
  EMPTY_SAVED_INPUT_DRAFT_STATE,
  evaluateRunGate,
  findOutputDocument,
  findRunOutputDocument,
  getRunAdditionalDocuments,
  getRunMediaGalleryItems,
  getRunRawAttachments,
  INLINE_INTERACTION_KINDS,
  isAgentSelectable,
  isInteractionAnswerable,
  isRunActive,
  isTerminalRunStatus,
  orderRecentlyUpdatedSkills,
  orderRecentlyVisitedSkills,
  skillEditorAvatar,
  routeInteraction,
  runBadgeStatus,
  runOutputMode,
  runHarnessUnavailableCopy,
  runShortId,
  parseRunTemplateSelection,
  resolveRunTemplateSelection,
  savedInputDraftDirty,
  selectedSavedInputDraft,
  serializeRunTemplateSelection,
  shouldPollRun,
  showRunErrorCard,
  syncSavedInputDraftState,
  testTaskLinkState,
} from "./skill-studio";

const ALL_STATUSES: CompanySkillTestRunStatus[] = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
];

function makeRunDocument(overrides: Partial<IssueDocument> & { id: string; key: string }): IssueDocument {
  const { id, key, ...documentOverrides } = overrides;
  return {
    id,
    companyId: "company-1",
    issueId: "issue-1",
    key,
    title: overrides.title ?? null,
    format: "markdown",
    latestRevisionId: "revision-1",
    latestRevisionNumber: 1,
    createdByAgentId: null,
    createdByUserId: null,
    updatedByAgentId: null,
    updatedByUserId: null,
    lockedAt: null,
    lockedByAgentId: null,
    lockedByUserId: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    body: overrides.body ?? "",
    ...documentOverrides,
  };
}

function makeRunAttachment(overrides: Partial<IssueAttachment> & { id: string }): IssueAttachment {
  const { id, ...attachmentOverrides } = overrides;
  return {
    id,
    companyId: "company-1",
    issueId: "issue-1",
    issueCommentId: null,
    assetId: `asset-${id}`,
    provider: "local",
    objectKey: `attachments/${id}`,
    contentType: overrides.contentType ?? "text/plain",
    byteSize: overrides.byteSize ?? 512,
    sha256: "0".repeat(64),
    originalFilename: overrides.originalFilename ?? `${id}.txt`,
    createdByAgentId: null,
    createdByUserId: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    contentPath: overrides.contentPath ?? `/api/attachments/${id}/content`,
    openPath: overrides.openPath ?? `/api/attachments/${id}/content`,
    downloadPath: overrides.downloadPath ?? `/api/attachments/${id}/content?download=1`,
    ...attachmentOverrides,
  };
}

function makeArtifactWorkProduct(
  overrides: Partial<IssueWorkProduct> & {
    id: string;
    attachmentId?: string;
    contentPath?: string;
    contentType?: string;
    originalFilename?: string;
  },
): IssueWorkProduct {
  const { id, attachmentId: overrideAttachmentId, contentPath: overrideContentPath, contentType, originalFilename, ...workProductOverrides } = overrides;
  const attachmentId = overrideAttachmentId ?? `attachment-${id}`;
  const contentPath = overrideContentPath ?? `/api/attachments/${attachmentId}/content`;
  return {
    id,
    companyId: "company-1",
    projectId: null,
    issueId: "issue-1",
    executionWorkspaceId: null,
    runtimeServiceId: null,
    type: "artifact",
    provider: "paperclip",
    externalId: null,
    title: overrides.title ?? `Artifact ${id}`,
    url: null,
    status: "active",
    reviewState: "none",
    isPrimary: false,
    healthStatus: "unknown",
    summary: overrides.summary ?? null,
    metadata: {
      attachmentId,
      contentType: contentType ?? "image/png",
      byteSize: 1024,
      contentPath,
      openPath: contentPath,
      downloadPath: `${contentPath}?download=1`,
      originalFilename: originalFilename ?? `${id}.png`,
    },
    sourceTrust: null,
    createdByRunId: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...workProductOverrides,
  };
}

describe("run-status derivation", () => {
  it("classifies terminal vs non-terminal statuses", () => {
    expect(isTerminalRunStatus("queued")).toBe(false);
    expect(isTerminalRunStatus("running")).toBe(false);
    expect(isTerminalRunStatus("succeeded")).toBe(true);
    expect(isTerminalRunStatus("failed")).toBe(true);
    expect(isTerminalRunStatus("cancelled")).toBe(true);
  });

  it("polls only while non-terminal (V1 2s policy)", () => {
    expect(shouldPollRun("queued")).toBe(true);
    expect(shouldPollRun("running")).toBe(true);
    for (const status of ["succeeded", "failed", "cancelled"] as CompanySkillTestRunStatus[]) {
      expect(shouldPollRun(status)).toBe(false);
    }
  });

  it("isRunActive is the inverse of terminal", () => {
    for (const status of ALL_STATUSES) {
      expect(isRunActive({ status })).toBe(!isTerminalRunStatus(status));
    }
  });

  it("maps every status onto a StatusBadge status (D6)", () => {
    for (const status of ALL_STATUSES) {
      expect(runBadgeStatus(status)).toBe(status);
    }
  });

  it("shows an error card only for failed runs (cancelled has none)", () => {
    expect(showRunErrorCard("failed")).toBe(true);
    expect(showRunErrorCard("cancelled")).toBe(false);
    expect(showRunErrorCard("succeeded")).toBe(false);
    expect(showRunErrorCard("running")).toBe(false);
  });

  describe("output mode", () => {
    it("succeeded with output renders the output", () => {
      expect(runOutputMode({ status: "succeeded", outputBody: "# Result" })).toBe("output");
    });
    it("succeeded with no output renders none", () => {
      expect(runOutputMode({ status: "succeeded", outputBody: "" })).toBe("none");
      expect(runOutputMode({ status: "succeeded", outputBody: null })).toBe("none");
    });
    it("failed with partial output is a draft-at-failure", () => {
      expect(runOutputMode({ status: "failed", outputBody: "partial" })).toBe("draft");
    });
    it("cancelled with partial output is a draft-at-failure", () => {
      expect(runOutputMode({ status: "cancelled", outputBody: "partial" })).toBe("draft");
    });
    it("failed with no output renders none", () => {
      expect(runOutputMode({ status: "failed", outputBody: "   " })).toBe("none");
    });
    it("non-terminal with no output is pending, with output shows it streaming", () => {
      expect(runOutputMode({ status: "running", outputBody: "" })).toBe("pending");
      expect(runOutputMode({ status: "queued", outputBody: null })).toBe("pending");
      expect(runOutputMode({ status: "running", outputBody: "live" })).toBe("output");
    });
  });

  describe("test-task deep link state", () => {
    it("is enabled for a live harness issue", () => {
      expect(testTaskLinkState({ taskExpired: false, harnessIssue: { id: "i1" } })).toEqual({
        enabled: true,
        reason: null,
      });
    });
    it("is disabled when the task expired", () => {
      expect(testTaskLinkState({ taskExpired: true, harnessIssue: { id: "i1" } })).toEqual({
        enabled: false,
        reason: "Test task expired",
      });
    });
    it("is disabled when the harness issue was deleted", () => {
      expect(testTaskLinkState({ taskExpired: false, harnessIssue: null })).toEqual({
        enabled: false,
        reason: "Test task expired",
      });
    });
  });
});

describe("rich run output helpers", () => {
  it("separates the output document from additional documents and raw attachments", () => {
    const outputDocument = makeRunDocument({
      id: "doc-output",
      key: "output",
      title: "Output",
      body: "## Primary result",
    });
    const notesDocument = makeRunDocument({
      id: "doc-notes",
      key: "notes",
      title: "Notes",
      body: "Follow-up notes",
    });
    const promotedAttachmentId = "11111111-1111-4111-8111-111111111111";
    const promotedAttachment = makeRunAttachment({
      id: promotedAttachmentId,
      contentType: "image/png",
      originalFilename: "output.png",
    });
    const rawAttachment = makeRunAttachment({
      id: "attachment-notes",
      contentType: "text/markdown",
      originalFilename: "notes.md",
    });
    const workProduct = makeArtifactWorkProduct({
      id: "wp-output",
      attachmentId: promotedAttachmentId,
      contentPath: promotedAttachment.contentPath,
      originalFilename: "output.png",
    });
    const detail = {
      outputDocumentKey: "output",
      harnessContent: {
        available: true,
        unavailableReason: null,
        documents: [outputDocument, notesDocument],
        attachments: [promotedAttachment, rawAttachment],
        workProducts: [workProduct],
      },
    };

    expect(findRunOutputDocument(detail)).toBe(outputDocument);
    expect(getRunAdditionalDocuments(detail)).toEqual([notesDocument]);
    expect(getRunRawAttachments(detail)).toEqual([rawAttachment]);
    expect(getRunMediaGalleryItems(detail).map((item) => item.id)).toEqual([promotedAttachment.id]);
  });

  it("adds media work products to the gallery when no matching attachment is present", () => {
    const videoAttachmentId = "22222222-2222-4222-8222-222222222222";
    const workProduct = makeArtifactWorkProduct({
      id: "wp-video",
      attachmentId: videoAttachmentId,
      contentType: "video/webm",
      contentPath: `/api/attachments/${videoAttachmentId}/content`,
      originalFilename: "demo.webm",
    });
    const detail = {
      outputDocumentKey: "output",
      harnessContent: {
        available: true,
        unavailableReason: null,
        documents: [],
        attachments: [],
        workProducts: [workProduct],
      },
    };

    expect(getRunMediaGalleryItems(detail)).toEqual([
      expect.objectContaining({
        id: "work-product-wp-video",
        contentPath: `/api/attachments/${videoAttachmentId}/content`,
        contentType: "video/webm",
        originalFilename: "demo.webm",
      }),
    ]);
  });

  it("reports an unavailable deleted harness while leaving rich collections quiet", () => {
    const detail = {
      outputDocumentKey: "output",
      harnessContent: {
        available: false,
        unavailableReason: "deleted" as const,
        documents: [],
        attachments: [],
        workProducts: [],
      },
    };

    expect(runHarnessUnavailableCopy(detail)).toEqual({
      title: "Test task deleted",
      body: "Stored run snapshots are still shown. Harness documents, attachments, and work products are no longer available.",
    });
    expect(getRunAdditionalDocuments(detail)).toEqual([]);
    expect(getRunRawAttachments(detail)).toEqual([]);
    expect(getRunMediaGalleryItems(detail)).toEqual([]);
  });
});

describe("disabled-Run matrix", () => {
  const ready = { hasAgent: true, hasInput: true, skillFileCount: 3 };

  it("enables Run when agent + input + files are all present", () => {
    expect(evaluateRunGate(ready)).toEqual({ disabled: false, reason: null });
  });

  it("blocks on zero skill files first", () => {
    expect(evaluateRunGate({ ...ready, skillFileCount: 0 })).toEqual({
      disabled: true,
      reason: "This skill has no files to test",
    });
  });

  it("blocks when no agent is selected", () => {
    expect(evaluateRunGate({ ...ready, hasAgent: false })).toEqual({
      disabled: true,
      reason: "Pick an agent to run",
    });
  });

  it("blocks when the input is empty", () => {
    expect(evaluateRunGate({ ...ready, hasInput: false })).toEqual({
      disabled: true,
      reason: "Add or paste input text to run",
    });
  });

  it("blocks when skill editor edits are unsaved", () => {
    expect(evaluateRunGate({ ...ready, hasUnsavedSkillEdits: true })).toEqual({
      disabled: true,
      reason: "Save skill edits before running",
    });
  });

  it("blocks when a run is already in flight", () => {
    expect(evaluateRunGate({ ...ready, runInFlight: true })).toEqual({
      disabled: true,
      reason: "A run is already in progress",
    });
  });

  it("zero files takes priority over missing agent and input", () => {
    expect(
      evaluateRunGate({ hasAgent: false, hasInput: false, skillFileCount: 0 }).reason,
    ).toBe("This skill has no files to test");
  });

  it("missing agent takes priority over missing input", () => {
    expect(
      evaluateRunGate({ hasAgent: false, hasInput: false, skillFileCount: 2 }).reason,
    ).toBe("Pick an agent to run");
  });
});

describe("saved input editor draft state", () => {
  const savedInput = { id: "input-1", content: "existing content" };

  it("populates the editor when a selected input record arrives after initial render", () => {
    const state = syncSavedInputDraftState(EMPTY_SAVED_INPUT_DRAFT_STATE, savedInput);

    expect(selectedSavedInputDraft(state, savedInput)).toBe("existing content");
    expect(savedInputDraftDirty(state, savedInput)).toBe(false);
  });

  it("switches draft state when a different saved input is selected", () => {
    const first = syncSavedInputDraftState(EMPTY_SAVED_INPUT_DRAFT_STATE, savedInput);
    const secondInput = { id: "input-2", content: "second body" };
    const second = syncSavedInputDraftState({ ...first, draft: "local edit" }, secondInput);

    expect(second).toEqual({
      inputId: "input-2",
      draft: "second body",
      baselineContent: "second body",
    });
  });

  it("adopts background refetch content while the local draft is clean", () => {
    const initial = syncSavedInputDraftState(EMPTY_SAVED_INPUT_DRAFT_STATE, savedInput);
    const updated = syncSavedInputDraftState(initial, {
      id: "input-1",
      content: "server update",
    });

    expect(selectedSavedInputDraft(updated, { id: "input-1", content: "server update" })).toBe("server update");
    expect(savedInputDraftDirty(updated, { id: "input-1", content: "server update" })).toBe(false);
  });

  it("preserves a dirty local draft across background refetches", () => {
    const initial = syncSavedInputDraftState(EMPTY_SAVED_INPUT_DRAFT_STATE, savedInput);
    const dirty = { ...initial, draft: "local edit" };
    const afterRefetch = syncSavedInputDraftState(dirty, {
      id: "input-1",
      content: "server update",
    });

    expect(selectedSavedInputDraft(afterRefetch, { id: "input-1", content: "server update" })).toBe("local edit");
    expect(savedInputDraftDirty(afterRefetch, { id: "input-1", content: "server update" })).toBe(true);
  });
});

describe("interaction inline-vs-fallback routing", () => {
  it("renders ask_user_questions and request_confirmation inline", () => {
    expect(routeInteraction("ask_user_questions")).toBe("inline");
    expect(routeInteraction("request_confirmation")).toBe("inline");
    expect(INLINE_INTERACTION_KINDS.has("ask_user_questions")).toBe(true);
  });

  it("routes every other kind to the fallback summary row", () => {
    for (const kind of [
      "suggest_tasks",
      "request_checkbox_confirmation",
      "request_board_approval",
      "some_future_kind",
    ]) {
      expect(routeInteraction(kind)).toBe("fallback");
    }
  });

  it("only answers inline interactions that are still pending", () => {
    expect(isInteractionAnswerable({ kind: "ask_user_questions", status: "pending" })).toBe(true);
    expect(isInteractionAnswerable({ kind: "ask_user_questions", status: "answered" })).toBe(false);
    expect(isInteractionAnswerable({ kind: "request_confirmation", status: "accepted" })).toBe(false);
    // Fallback kinds are never answerable inline even while pending.
    expect(isInteractionAnswerable({ kind: "suggest_tasks", status: "pending" })).toBe(false);
  });
});

describe("agent picker + run labels", () => {
  it("marks paused agents as unselectable", () => {
    expect(isAgentSelectable({ status: "active" })).toBe(true);
    expect(isAgentSelectable({ status: "idle" })).toBe(true);
    expect(isAgentSelectable({ status: "paused" })).toBe(false);
  });

  it("builds a short run id", () => {
    expect(runShortId({ id: "abcdef01-2345-6789-abcd-ef0123456789" })).toBe("#abcdef0");
  });

  it("finds the output document by the run's output key", () => {
    const detail = {
      outputDocumentKey: "output",
      documents: [
        { key: "notes", title: "Notes", updatedAt: new Date(), body: "n" },
        { key: "output", title: "Output", updatedAt: new Date(), body: "o" },
      ],
    };
    expect(findOutputDocument(detail)?.body).toBe("o");
    expect(findOutputDocument({ outputDocumentKey: "missing", documents: detail.documents })).toBeNull();
  });

  describe("buildReRunRequest", () => {
    it("reproduces a saved-input run from its own snapshots (never live picker state)", () => {
      const req = buildReRunRequest({
        agentId: "agent-9",
        inputId: "input-3",
        inputSnapshot: "snapshotted text",
        skillVersionId: "ver-7",
        templateId: "template-1",
        templateName: "Focused smoke",
        templateBody: "Original {{skillName}}",
      });
      expect(req).toEqual({
        agentId: "agent-9",
        inputId: "input-3",
        content: undefined,
        skillVersionId: "ver-7",
        templateSnapshot: {
          templateId: "template-1",
          templateName: "Focused smoke",
          templateBody: "Original {{skillName}}",
        },
      });
    });

    it("replays an ad-hoc run via its input snapshot as literal content", () => {
      const req = buildReRunRequest({
        agentId: "agent-1",
        inputId: null,
        inputSnapshot: "ad-hoc paste body",
        skillVersionId: "ver-2",
        templateId: null,
        templateName: null,
        templateBody: null,
      });
      expect(req.inputId).toBeUndefined();
      expect(req.content).toBe("ad-hoc paste body");
      expect(req.agentId).toBe("agent-1");
      expect(req.skillVersionId).toBe("ver-2");
      expect(req.templateSnapshot).toEqual({
        templateId: null,
        templateName: null,
        templateBody: null,
      });
    });

    it("always carries the run's agent id so a re-run never posts a null agent", () => {
      const req = buildReRunRequest({
        agentId: "agent-42",
        inputId: null,
        inputSnapshot: "x",
        skillVersionId: "v",
        templateId: "built-in:default-test-template",
        templateName: "Default test template",
        templateBody: "Default",
      });
      expect(req.agentId).toBe("agent-42");
    });

    it("preserves the viewed run's template snapshot instead of live template state", () => {
      const req = buildReRunRequest({
        agentId: "agent-42",
        inputId: null,
        inputSnapshot: "x",
        skillVersionId: "v",
        templateId: "template-old",
        templateName: "Old template name",
        templateBody: "Old body {{skillName}}",
      });

      expect(req.templateSnapshot).toEqual({
        templateId: "template-old",
        templateName: "Old template name",
        templateBody: "Old body {{skillName}}",
      });
    });
  });
});

describe("advanced run template helpers", () => {
  const defaultTemplate: CompanySkillTestRunTemplate = {
    id: DEFAULT_TEST_RUN_TEMPLATE_ID,
    companyId: "company-1",
    name: "Default test template",
    description: "Default",
    body: "Default {{skillName}}",
    builtIn: true,
    createdByAgentId: null,
    createdByUserId: null,
    updatedByAgentId: null,
    updatedByUserId: null,
    deletedAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  };
  const customTemplate: CompanySkillTestRunTemplate = {
    ...defaultTemplate,
    id: "template-1",
    name: "Focused smoke",
    description: null,
    body: "Custom {{skillName}}",
    builtIn: false,
  };

  it("serializes the No template selection distinctly from default", () => {
    const serialized = serializeRunTemplateSelection(null);

    expect(parseRunTemplateSelection(serialized)).toBeNull();
    expect(parseRunTemplateSelection(null)).toBe(DEFAULT_TEST_RUN_TEMPLATE_ID);
    expect(parseRunTemplateSelection("template-1")).toBe("template-1");
  });

  it("keeps valid server-backed selections and the explicit No template choice", () => {
    expect(resolveRunTemplateSelection(customTemplate.id, [defaultTemplate, customTemplate])).toEqual({
      selection: "template-1",
      template: customTemplate,
      recovered: false,
    });
    expect(resolveRunTemplateSelection(null, [defaultTemplate])).toEqual({
      selection: null,
      template: null,
      recovered: false,
    });
  });

  it("recovers stale local selections to the server-backed default template", () => {
    expect(resolveRunTemplateSelection("deleted-template", [defaultTemplate, customTemplate])).toEqual({
      selection: DEFAULT_TEST_RUN_TEMPLATE_ID,
      template: defaultTemplate,
      recovered: true,
    });
  });

  it("builds run-create payloads with the selected template id", () => {
    expect(
      buildCreateRunRequest({
        agentId: "agent-1",
        inputId: "input-1",
        content: null,
        templateId: customTemplate.id,
      }),
    ).toEqual({
      agentId: "agent-1",
      inputId: "input-1",
      content: null,
      templateId: "template-1",
    });

    expect(
      buildCreateRunRequest({
        agentId: "agent-1",
        inputId: null,
        content: "ad-hoc",
        templateId: null,
      }).templateId,
    ).toBeNull();
  });
});

describe("studio landing recency helpers", () => {
  function makeSkill(
    overrides: Partial<CompanySkillListItem> & { id: string },
  ): CompanySkillListItem {
    return {
      companyId: "company-1",
      key: overrides.id,
      slug: overrides.id,
      name: overrides.id,
      description: null,
      sourceType: "local_path",
      sourceLocator: null,
      sourceRef: null,
      trustLevel: "markdown_only",
      compatibility: "compatible",
      fileInventory: [],
      iconUrl: null,
      color: null,
      tagline: null,
      authorName: null,
      homepageUrl: null,
      categories: [],
      sharingScope: "private",
      publicShareToken: null,
      forkedFromSkillId: null,
      forkedFromCompanyId: null,
      starCount: 0,
      installCount: 0,
      forkCount: 0,
      currentVersionId: null,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
      attachedAgentCount: 0,
      editable: true,
      editableReason: null,
      sourceLabel: null,
      sourceBadge: "local",
      sourcePath: null,
      catalogKind: null,
      originHash: null,
      packageName: null,
      packageVersion: null,
      ...overrides,
    };
  }

  describe("orderRecentlyVisitedSkills", () => {
    it("orders by recency, drops stale/foreign ids, and caps at the limit", () => {
      const skills = [makeSkill({ id: "a" }), makeSkill({ id: "b" }), makeSkill({ id: "c" })];
      const result = orderRecentlyVisitedSkills(skills, ["c", "missing", "a"]);
      expect(result.map((s) => s.id)).toEqual(["c", "a"]);
    });

    it("dedupes repeated ids and respects the limit", () => {
      const skills = Array.from({ length: 8 }, (_, i) => makeSkill({ id: `s${i}` }));
      const recent = ["s0", "s0", "s1", "s2", "s3", "s4", "s5"];
      const result = orderRecentlyVisitedSkills(skills, recent, 5);
      expect(result.map((s) => s.id)).toEqual(["s0", "s1", "s2", "s3", "s4"]);
    });

    it("returns empty when nothing matches", () => {
      expect(orderRecentlyVisitedSkills([makeSkill({ id: "a" })], ["x", "y"])).toEqual([]);
    });
  });

  describe("orderRecentlyUpdatedSkills", () => {
    it("sorts by updatedAt desc and excludes the visited ids", () => {
      const skills = [
        makeSkill({ id: "old", updatedAt: new Date("2026-01-01T00:00:00Z") }),
        makeSkill({ id: "new", updatedAt: new Date("2026-03-01T00:00:00Z") }),
        makeSkill({ id: "mid", updatedAt: new Date("2026-02-01T00:00:00Z") }),
      ];
      const result = orderRecentlyUpdatedSkills(skills, ["mid"]);
      expect(result.map((s) => s.id)).toEqual(["new", "old"]);
    });

    it("handles ISO-string updatedAt from the wire and caps at the limit", () => {
      const skills = Array.from({ length: 12 }, (_, i) =>
        makeSkill({
          id: `s${i}`,
          // later index -> more recent
          updatedAt: new Date(2026, 0, i + 1).toISOString() as unknown as Date,
        }),
      );
      const result = orderRecentlyUpdatedSkills(skills, []);
      expect(result).toHaveLength(10);
      expect(result[0]!.id).toBe("s11");
    });

    it("breaks updatedAt ties by name", () => {
      const when = new Date("2026-01-01T00:00:00Z");
      const skills = [
        makeSkill({ id: "z", name: "Zebra", updatedAt: when }),
        makeSkill({ id: "a", name: "Apple", updatedAt: when }),
      ];
      expect(orderRecentlyUpdatedSkills(skills, []).map((s) => s.name)).toEqual([
        "Apple",
        "Zebra",
      ]);
    });
  });

  describe("skillEditorAvatar", () => {
    const userEditor: CompanySkillLastEditor = {
      kind: "user",
      id: "user-1",
      name: "Ada Lovelace",
      imageUrl: "https://example.com/ada.png",
    };

    it("returns image + initials for a human editor", () => {
      expect(skillEditorAvatar(userEditor)).toEqual({
        name: "Ada Lovelace",
        imageUrl: "https://example.com/ada.png",
        initials: "AL",
      });
    });

    it("derives two-letter initials from a single name", () => {
      expect(skillEditorAvatar({ ...userEditor, name: "Cher" })?.initials).toBe("CH");
    });

    it("falls back to a placeholder name when unnamed", () => {
      expect(skillEditorAvatar({ ...userEditor, name: null })).toEqual({
        name: "Unknown editor",
        imageUrl: "https://example.com/ada.png",
        initials: "UE",
      });
    });

    it("returns null for agent edits and unattributed syncs", () => {
      expect(
        skillEditorAvatar({ kind: "agent", id: "a1", name: "Bot", imageUrl: null }),
      ).toBeNull();
      expect(skillEditorAvatar(null)).toBeNull();
      expect(skillEditorAvatar(undefined)).toBeNull();
    });
  });
});
