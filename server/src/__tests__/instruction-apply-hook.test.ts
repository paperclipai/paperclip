import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../errors.ts";
import {
  INSTRUCTION_APPLY_ORIGIN_KIND,
  computeInstructionBundleFingerprint,
  createInstructionApplyTask,
} from "../services/instruction-apply-hook.ts";

const mockIssueService = vi.hoisted(() => ({
  create: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/issues.js", () => ({
  issueService: vi.fn(() => mockIssueService),
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
}));

vi.mock("../middleware/logger.js", () => ({
  logger: { warn: vi.fn(), error: vi.fn() },
}));

const mockReadFile = vi.hoisted(() => vi.fn());
const mockReadCommittedForRuntime = vi.hoisted(() => vi.fn());

vi.mock("../services/agent-instructions.js", () => ({
  agentInstructionsBundleMode: vi.fn(() => "managed"),
  agentInstructionsService: vi.fn(() => ({ readFile: mockReadFile })),
  deriveBundleState: vi.fn(() => ({ entryFile: "AGENTS.md" })),
}));

vi.mock("../services/agent-instruction-revisions.js", () => ({
  agentInstructionRevisionService: vi.fn(() => ({ readCommittedForRuntime: mockReadCommittedForRuntime })),
}));

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const ENTRY_BASE = sha256("# Current entry\n");

const agentRow = { id: "agent-1", companyId: "company-1", name: "Kai" };

function createDbStub(selectResults: unknown[][]) {
  const pendingSelectResults = [...selectResults];
  const where = vi.fn(async () => pendingSelectResults.shift() ?? []);
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  const execute = vi.fn(async () => undefined);
  const tx = { select, execute };
  const transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(tx));
  return { db: { select, transaction } as any, tx, execute, where };
}

const bundlePayload = {
  agentId: "agent-1",
  bundle: {
    files: [{ path: "AGENTS.md", content: "# Managed instructions\n" }],
  },
};

describe("createInstructionApplyTask", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLogActivity.mockResolvedValue(undefined);
    mockIssueService.create.mockResolvedValue({ id: "issue-1" });
    mockReadCommittedForRuntime.mockResolvedValue({ revision: { contentHash: ENTRY_BASE } });
    mockReadFile.mockRejectedValue(new HttpError(404, "Instructions file not found"));
  });

  it("creates a board-auth apply task carrying the approved bundle", async () => {
    const { db, tx, execute } = createDbStub([[agentRow], []]);

    const result = await createInstructionApplyTask(db, {
      companyId: "company-1",
      approvalId: "approval-1",
      decidedByUserId: "board",
      payload: bundlePayload,
    });

    expect(result).toEqual({ issueId: "issue-1", created: true });
    expect(mockIssueService.create).toHaveBeenCalledTimes(1);
    const [companyId, data, createTx] = mockIssueService.create.mock.calls[0];
    expect(companyId).toBe("company-1");
    // Lookup and insert run in the same locked transaction
    expect(createTx).toBe(tx);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(data.title).toBe("Apply approved instruction bundle — Kai");
    expect(data.status).toBe("todo");
    expect(data.originKind).toBe(INSTRUCTION_APPLY_ORIGIN_KIND);
    expect(data.originId).toBe("agent-1");
    expect(data.originFingerprint).toBe(
      computeInstructionBundleFingerprint("agent-1", bundlePayload.bundle.files),
    );
    expect(data.description).toContain("PUT /api/agents/agent-1/instructions-bundle/file");
    expect(data.description).not.toContain("GET /api/agents/agent-1/instructions-bundle/file");
    expect(data.description).toContain('"baseHash": <reviewed base listed under that file>');
    // The entry file is pinned to its committed revision at approval time
    expect(data.description).toContain(`Reviewed base: \`${ENTRY_BASE}\``);
    expect(data.description).toContain(
      `Expected \`contentHash\` after the write: \`${sha256("# Managed instructions\n")}\``,
    );
    expect(data.description).toContain("# Managed instructions");
    expect(mockLogActivity).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ action: "approval.apply_task_created" }),
    );
  });

  it("keeps a review base recorded in the payload instead of reading the current file", async () => {
    const { db } = createDbStub([[agentRow], []]);
    const reviewedBase = sha256("# Reviewed entry\n");

    await createInstructionApplyTask(db, {
      companyId: "company-1",
      approvalId: "approval-base",
      decidedByUserId: "board",
      payload: {
        agentId: "agent-1",
        bundle: { files: [{ path: "AGENTS.md", content: "# Managed instructions\n", baseHash: reviewedBase }] },
      },
    });

    const [, data] = mockIssueService.create.mock.calls[0];
    expect(data.description).toContain(`Reviewed base: \`${reviewedBase}\``);
    expect(mockReadCommittedForRuntime).not.toHaveBeenCalled();
    expect(mockReadFile).not.toHaveBeenCalled();
  });

  it("pins other managed files to their approval-time hash, or null when they do not exist yet", async () => {
    const { db } = createDbStub([[agentRow], []]);
    const soulBase = sha256("# Soul\n");
    mockReadFile.mockImplementation(async (_agent: unknown, path: string) => {
      if (path === "SOUL.md") return { path, contentHash: soulBase };
      throw new HttpError(404, "Instructions file not found");
    });

    await createInstructionApplyTask(db, {
      companyId: "company-1",
      approvalId: "approval-files",
      decidedByUserId: "board",
      payload: {
        agentId: "agent-1",
        bundle: {
          files: [
            { path: "SOUL.md", content: "# Soul v2\n" },
            { path: "TOOLS.md", content: "# Tools\n" },
          ],
        },
      },
    });

    const [, data] = mockIssueService.create.mock.calls[0];
    expect(data.description).toContain(`### \`SOUL.md\`\n\nReviewed base: \`${soulBase}\``);
    expect(data.description).toContain("### `TOOLS.md`\n\nReviewed base: `null` (new file)");
    expect(mockReadCommittedForRuntime).not.toHaveBeenCalled();
  });

  it("rejects a payload whose review base is not a content hash", async () => {
    const { db } = createDbStub([]);

    const result = await createInstructionApplyTask(db, {
      companyId: "company-1",
      approvalId: "approval-bad-base",
      decidedByUserId: "board",
      payload: {
        agentId: "agent-1",
        bundle: { files: [{ path: "AGENTS.md", content: "x", baseHash: "rev-1" }] },
      },
    });

    expect(result).toBeNull();
    expect(mockIssueService.create).not.toHaveBeenCalled();
    expect(mockLogActivity).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ action: "instruction_apply_hook.invalid_payload" }),
    );
  });

  it("quote-prefixes every line of a multi-line note", async () => {
    const { db } = createDbStub([[agentRow], []]);

    await createInstructionApplyTask(db, {
      companyId: "company-1",
      approvalId: "approval-note",
      decidedByUserId: "board",
      payload: { ...bundlePayload, note: "first line\nsecond line" },
    });

    const [, data] = mockIssueService.create.mock.calls[0];
    expect(data.description).toContain("> first line\n> second line");
  });

  it("widens the code fence past the longest backtick run in file content", async () => {
    const { db } = createDbStub([[agentRow], []]);
    const content = "````markdown\nnested four-backtick fence\n````\n";

    await createInstructionApplyTask(db, {
      companyId: "company-1",
      approvalId: "approval-fence",
      decidedByUserId: "board",
      payload: {
        agentId: "agent-1",
        bundle: { files: [{ path: "AGENTS.md", content }] },
      },
    });

    const [, data] = mockIssueService.create.mock.calls[0];
    expect(data.description).toContain("`````markdown\n````markdown");
    expect(data.description).toContain("````\n`````");
  });

  it("reuses an existing open apply task for the same agent and bundle fingerprint", async () => {
    const { db } = createDbStub([[agentRow], [{ id: "existing-1" }]]);

    const result = await createInstructionApplyTask(db, {
      companyId: "company-1",
      approvalId: "approval-2",
      decidedByUserId: "board",
      payload: bundlePayload,
    });

    expect(result).toEqual({ issueId: "existing-1", created: false });
    expect(mockIssueService.create).not.toHaveBeenCalled();
    expect(mockLogActivity).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ action: "approval.apply_task_deduped" }),
    );
  });

  it("skips with activity when the payload has no bundle files", async () => {
    const { db } = createDbStub([]);

    const result = await createInstructionApplyTask(db, {
      companyId: "company-1",
      approvalId: "approval-3",
      decidedByUserId: "board",
      payload: { agentId: "agent-1" },
    });

    expect(result).toBeNull();
    expect(mockIssueService.create).not.toHaveBeenCalled();
    expect(mockLogActivity).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ action: "instruction_apply_hook.invalid_payload" }),
    );
  });

  it("skips with activity when the target agent is not in the company", async () => {
    const { db } = createDbStub([[]]);

    const result = await createInstructionApplyTask(db, {
      companyId: "company-1",
      approvalId: "approval-4",
      decidedByUserId: "board",
      payload: bundlePayload,
    });

    expect(result).toBeNull();
    expect(mockIssueService.create).not.toHaveBeenCalled();
    expect(mockLogActivity).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ action: "instruction_apply_hook.agent_not_found" }),
    );
  });

  it("never throws: issue-creation failures resolve to null with an error activity", async () => {
    const { db } = createDbStub([[agentRow], []]);
    mockIssueService.create.mockRejectedValue(new Error("insert failed"));

    const result = await createInstructionApplyTask(db, {
      companyId: "company-1",
      approvalId: "approval-5",
      decidedByUserId: "board",
      payload: bundlePayload,
    });

    expect(result).toBeNull();
    expect(mockLogActivity).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ action: "instruction_apply_hook.error" }),
    );
  });
});

describe("computeInstructionBundleFingerprint", () => {
  it("is stable across file ordering", () => {
    const files = [
      { path: "AGENTS.md", content: "a" },
      { path: "SOUL.md", content: "b" },
    ];
    const reversed = [...files].reverse();
    expect(computeInstructionBundleFingerprint("agent-1", files)).toBe(
      computeInstructionBundleFingerprint("agent-1", reversed),
    );
  });

  it("changes when content or agent changes", () => {
    const files = [{ path: "AGENTS.md", content: "a" }];
    const base = computeInstructionBundleFingerprint("agent-1", files);
    expect(computeInstructionBundleFingerprint("agent-2", files)).not.toBe(base);
    expect(
      computeInstructionBundleFingerprint("agent-1", [{ path: "AGENTS.md", content: "b" }]),
    ).not.toBe(base);
  });
});
