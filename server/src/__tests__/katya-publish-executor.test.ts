import { beforeEach, describe, expect, it, vi } from "vitest";
import { tickKatyaPublishExecutor } from "../services/katya-publish-executor.js";

// ─── DB mock helpers ──────────────────────────────────────────────────────────

/**
 * Minimal drizzle-style query builder mock.
 * Each call to `select` consumes one entry from `selectQueue`.
 * Each call to `update` consumes one entry from `updateQueue`.
 */
function buildDbMock(opts: {
  selectQueue: unknown[][];
  updateReturning?: unknown[][];
}) {
  const selectQueue = [...opts.selectQueue];
  const updateQueue = opts.updateReturning ? [...opts.updateReturning] : [];

  const makeSelect = () => {
    const results = selectQueue.shift() ?? [];
    const where = vi.fn(() => Promise.resolve(results));
    const innerJoinWhere = vi.fn(() => Promise.resolve(results));
    const innerJoin = vi.fn(() => ({ where: innerJoinWhere }));
    const fromObj = { where, innerJoin };
    const from = vi.fn(() => fromObj);
    return { from };
  };

  const makeUpdate = () => {
    const returning = vi.fn(() => Promise.resolve(updateQueue.shift() ?? []));
    const where = vi.fn(() => ({ returning }));
    const set = vi.fn(() => ({ where }));
    return { set };
  };

  const dbMock = {
    select: vi.fn(() => makeSelect()),
    update: vi.fn(() => makeUpdate()),
  };

  return dbMock;
}

// ─── Fixture factories ────────────────────────────────────────────────────────

function makeWP(overrides: Record<string, unknown> = {}) {
  return {
    id: "wp-1",
    issueId: "issue-1",
    companyId: "company-1",
    metadata: { approvalId: "approval-1" },
    ...overrides,
  };
}

function makeApproval(overrides: Record<string, unknown> = {}) {
  return {
    id: "approval-1",
    companyId: "company-1",
    type: "approve_ceo_strategy",
    status: "approved",
    payload: { channel: "blog", draft: "Hello world" },
    ...overrides,
  };
}

const PLACEHOLDER = "{{BLOG_URL_CANONICAL}}";
const BLOG_URL = "https://pelergy.com/blog/2026-04-test";

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("tickKatyaPublishExecutor", () => {
  describe("empty queue", () => {
    it("returns zeros and makes no further DB calls when no active WPs exist", async () => {
      const db = buildDbMock({ selectQueue: [[]] });
      const result = await tickKatyaPublishExecutor(db as any);
      expect(result).toEqual({
        checked: 0,
        blogsDiscovered: 0,
        socialsSubstituted: 0,
        socialsDeferred: 0,
        errors: 0,
      });
      expect(db.select).toHaveBeenCalledTimes(1);
      expect(db.update).not.toHaveBeenCalled();
    });
  });

  describe("blog-first ordering", () => {
    it("discovers blog canonical URL and makes it available for social in the same pass", async () => {
      const blogWP = makeWP({ id: "wp-blog", metadata: { approvalId: "approval-blog" } });
      const socialWP = makeWP({
        id: "wp-social",
        metadata: { approvalId: "approval-social" },
      });

      const blogApproval = makeApproval({
        id: "approval-blog",
        payload: { channel: "blog", draft: "Blog post", publishedUrl: BLOG_URL },
      });
      const socialApproval = makeApproval({
        id: "approval-social",
        payload: {
          channel: "linkedin",
          draft: `Read more: ${PLACEHOLDER}`,
          draft_full: `Full post: ${PLACEHOLDER}`,
          linkUrl: PLACEHOLDER,
        },
      });

      const db = buildDbMock({
        // 1: active WPs, 2: batch approvals
        selectQueue: [
          [blogWP, socialWP],
          [blogApproval, socialApproval],
        ],
      });

      const result = await tickKatyaPublishExecutor(db as any);

      expect(result.blogsDiscovered).toBe(1);
      expect(result.socialsSubstituted).toBe(1);
      expect(result.socialsDeferred).toBe(0);
      // Two updates: work product metadata + social approval payload
      expect(db.update).toHaveBeenCalledTimes(2);
    });
  });

  describe("social deferral — blog URL not yet available", () => {
    it("defers social and records deferral metadata when blog has no published URL", async () => {
      const socialWP = makeWP({ metadata: { approvalId: "approval-social" } });
      const socialApproval = makeApproval({
        id: "approval-social",
        payload: {
          channel: "linkedin",
          draft: `Read more: ${PLACEHOLDER}`,
        },
      });
      const blogApprovalNoUrl = makeApproval({
        id: "approval-blog",
        payload: { channel: "blog", draft: "Unpublished blog" },
      });

      // No blog WPs in queue — launch checklist select is skipped.
      // select sequence: (1) active WPs, (2) batch approvals, (3) blog join (returns blog with no URL).
      const db = buildDbMock({
        selectQueue: [
          [socialWP],
          [socialApproval],
          [blogApprovalNoUrl], // blog join — blog has no URL
        ],
      });

      const result = await tickKatyaPublishExecutor(db as any);

      expect(result.socialsDeferred).toBe(1);
      expect(result.socialsSubstituted).toBe(0);
      // Only the work product deferral metadata update
      expect(db.update).toHaveBeenCalledTimes(1);
    });

    it("defers when blog approval exists but URL is malformed (not https://)", async () => {
      const socialWP = makeWP({ metadata: { approvalId: "approval-social" } });
      const socialApproval = makeApproval({
        id: "approval-social",
        payload: { channel: "x", draft: `Link: ${PLACEHOLDER}` },
      });
      const blogWithBadUrl = makeApproval({
        id: "approval-blog-bad",
        payload: { channel: "blog", publishedUrl: "http://insecure.example.com/post" },
      });

      const db = buildDbMock({
        selectQueue: [
          [socialWP],
          [socialApproval],
          [blogWithBadUrl], // blog join — URL is http, not https
        ],
      });

      const result = await tickKatyaPublishExecutor(db as any);

      expect(result.socialsDeferred).toBe(1);
      expect(result.socialsSubstituted).toBe(0);
    });
  });

  describe("URL substitution", () => {
    it("substitutes {{BLOG_URL_CANONICAL}} in draft, draft_full, and linkUrl", async () => {
      // No blog WP in queue — social resolves blog URL via the issueApprovals join.
      const socialWP = makeWP({ metadata: { approvalId: "approval-social" } });
      const socialApproval = makeApproval({
        id: "approval-social",
        payload: {
          channel: "linkedin",
          draft: `Post body. ${PLACEHOLDER} #tag`,
          draft_full: `Full version: ${PLACEHOLDER}`,
          linkUrl: PLACEHOLDER,
        },
      });
      const blogApproval = makeApproval({
        id: "approval-blog",
        payload: { channel: "blog", publishedUrl: BLOG_URL },
      });

      // Capture what payload is written to the approval
      let capturedPayload: Record<string, unknown> | null = null;
      // Without any blog WPs, the launch-checklist select is skipped;
      // select call sequence: (1) active WPs, (2) batch approvals, (3) blog join.
      const db = {
        select: vi.fn()
          .mockReturnValueOnce({ from: vi.fn(() => ({ where: vi.fn(() => Promise.resolve([socialWP])) })) })
          .mockReturnValueOnce({ from: vi.fn(() => ({ where: vi.fn(() => Promise.resolve([socialApproval])) })) })
          .mockReturnValueOnce({ from: vi.fn(() => ({ innerJoin: vi.fn(() => ({ where: vi.fn(() => Promise.resolve([blogApproval])) })) })) }),
        update: vi.fn()
          .mockReturnValueOnce({
            set: vi.fn((patch: Record<string, unknown>) => {
              capturedPayload = patch.payload as Record<string, unknown>;
              return { where: vi.fn(() => Promise.resolve([])) };
            }),
          })
          .mockReturnValueOnce({ set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve([])) })) }),
      };

      const result = await tickKatyaPublishExecutor(db as any);

      expect(result.socialsSubstituted).toBe(1);
      expect(capturedPayload).not.toBeNull();
      expect(capturedPayload!.draft).toBe(`Post body. ${BLOG_URL} #tag`);
      expect(capturedPayload!.draft_full).toBe(`Full version: ${BLOG_URL}`);
      expect(capturedPayload!.linkUrl).toBe(BLOG_URL);
      expect(String(capturedPayload!.draft)).not.toContain(PLACEHOLDER);
    });

    it("replaces all occurrences of the placeholder in a single field", async () => {
      const socialWP = makeWP({ metadata: { approvalId: "approval-social" } });
      const socialApproval = makeApproval({
        id: "approval-social",
        payload: {
          channel: "linkedin",
          draft: `First: ${PLACEHOLDER} — Second: ${PLACEHOLDER}`,
        },
      });
      const blogApproval = makeApproval({
        id: "approval-blog",
        payload: { channel: "blog", publishedUrl: BLOG_URL },
      });

      let capturedPayload: Record<string, unknown> | null = null;
      const db = {
        select: vi.fn()
          .mockReturnValueOnce({ from: vi.fn(() => ({ where: vi.fn(() => Promise.resolve([socialWP])) })) })
          .mockReturnValueOnce({ from: vi.fn(() => ({ where: vi.fn(() => Promise.resolve([socialApproval])) })) })
          .mockReturnValueOnce({ from: vi.fn(() => ({ innerJoin: vi.fn(() => ({ where: vi.fn(() => Promise.resolve([blogApproval])) })) })) }),
        update: vi.fn()
          .mockReturnValueOnce({
            set: vi.fn((patch: Record<string, unknown>) => {
              capturedPayload = patch.payload as Record<string, unknown>;
              return { where: vi.fn(() => Promise.resolve([])) };
            }),
          })
          .mockReturnValueOnce({ set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve([])) })) }),
      };

      await tickKatyaPublishExecutor(db as any);

      expect(capturedPayload!.draft).toBe(`First: ${BLOG_URL} — Second: ${BLOG_URL}`);
    });
  });

  describe("standalone social (no placeholder)", () => {
    it("does not touch a social approval that has no {{BLOG_URL_CANONICAL}} placeholder", async () => {
      const socialWP = makeWP({ metadata: { approvalId: "approval-social" } });
      const socialApproval = makeApproval({
        id: "approval-social",
        payload: {
          channel: "linkedin",
          draft: "Post with a real link: https://pelergy.com/blog/already-published",
        },
      });

      const db = buildDbMock({
        selectQueue: [
          [socialWP],
          [socialApproval],
        ],
      });

      const result = await tickKatyaPublishExecutor(db as any);

      expect(result.socialsSubstituted).toBe(0);
      expect(result.socialsDeferred).toBe(0);
      expect(db.update).not.toHaveBeenCalled();
    });
  });

  describe("blog URL found via launch checklist fallback", () => {
    it("uses proof.urlOrPostId from launch_checklist_v1 when approval payload has no URL", async () => {
      // Blog WP present but blog approval has no publishedUrl yet.
      // However, launch_checklist_v1 has proof.urlOrPostId set.
      const blogWP = makeWP({ id: "wp-blog", metadata: { approvalId: "approval-blog" } });
      const socialWP = makeWP({ id: "wp-social", metadata: { approvalId: "approval-social" } });

      const blogApprovalNoUrl = makeApproval({
        id: "approval-blog",
        payload: { channel: "blog", draft: "Published blog, URL not yet in payload" },
      });
      const socialApproval = makeApproval({
        id: "approval-social",
        payload: { channel: "linkedin", draft: `Link: ${PLACEHOLDER}` },
      });
      const launchChecklist = {
        issueId: "issue-1",
        metadata: {
          proof: { urlOrPostId: BLOG_URL, timestamp: "2026-04-16T12:00:00Z", platformChannel: "blog" },
        },
      };

      const db = buildDbMock({
        selectQueue: [
          [blogWP, socialWP],
          [blogApprovalNoUrl, socialApproval],
          [launchChecklist], // launch checklist fallback
        ],
      });

      const result = await tickKatyaPublishExecutor(db as any);

      expect(result.blogsDiscovered).toBe(1);
      expect(result.socialsSubstituted).toBe(1);
      expect(result.socialsDeferred).toBe(0);
    });
  });

  describe("non-content approval types", () => {
    it("ignores work products with no channel in payload", async () => {
      const wp = makeWP({ metadata: { approvalId: "approval-hire" } });
      const hireApproval = makeApproval({
        id: "approval-hire",
        type: "hire_agent",
        payload: { agentId: "agent-1" }, // no channel field
      });

      const db = buildDbMock({
        selectQueue: [
          [wp],
          [hireApproval],
        ],
      });

      const result = await tickKatyaPublishExecutor(db as any);

      expect(result.checked).toBe(1);
      expect(result.blogsDiscovered).toBe(0);
      expect(result.socialsSubstituted).toBe(0);
      expect(result.socialsDeferred).toBe(0);
      expect(db.update).not.toHaveBeenCalled();
    });
  });

  describe("error handling", () => {
    it("records error count and continues processing remaining items when one social errors", async () => {
      const goodWP = makeWP({ id: "wp-good", metadata: { approvalId: "approval-social-good" } });
      const badWP = makeWP({ id: "wp-bad", issueId: "issue-bad", metadata: { approvalId: "approval-social-bad" } });

      const goodSocialApproval = makeApproval({
        id: "approval-social-good",
        payload: { channel: "linkedin", draft: `Link: ${PLACEHOLDER}` },
      });
      const badSocialApproval = makeApproval({
        id: "approval-social-bad",
        payload: { channel: "linkedin", draft: `Link: ${PLACEHOLDER}` },
      });
      const blogApproval = makeApproval({
        id: "approval-blog",
        payload: { channel: "blog", publishedUrl: BLOG_URL },
      });

      let updateCallCount = 0;
      const db = {
        select: vi.fn()
          .mockReturnValueOnce({ from: vi.fn(() => ({ where: vi.fn(() => Promise.resolve([goodWP, badWP])) })) })
          .mockReturnValueOnce({ from: vi.fn(() => ({ where: vi.fn(() => Promise.resolve([goodSocialApproval, badSocialApproval])) })) })
          // good social: launch checklist (empty), then blog join
          .mockReturnValueOnce({ from: vi.fn(() => ({ where: vi.fn(() => Promise.resolve([])) })) })
          .mockReturnValueOnce({ from: vi.fn(() => ({ innerJoin: vi.fn(() => ({ where: vi.fn(() => Promise.resolve([blogApproval])) })) })) })
          // bad social: launch checklist (empty), then blog join (throws)
          .mockReturnValueOnce({ from: vi.fn(() => ({ where: vi.fn(() => Promise.resolve([])) })) })
          .mockReturnValueOnce({ from: vi.fn(() => ({ innerJoin: vi.fn(() => ({ where: vi.fn(() => Promise.reject(new Error("DB error"))) })) })) }),
        update: vi.fn().mockReturnValue({
          set: vi.fn(() => ({
            where: vi.fn(() => {
              updateCallCount += 1;
              return Promise.resolve([]);
            }),
          })),
        }),
      };

      const result = await tickKatyaPublishExecutor(db as any);

      expect(result.errors).toBe(1);
      expect(result.socialsSubstituted).toBe(1); // good item still processed
    });
  });

  describe("missing approval ID in work product metadata", () => {
    it("skips work products with no approvalId in metadata", async () => {
      const wpNoApproval = makeWP({ metadata: {} }); // no approvalId

      const db = buildDbMock({
        selectQueue: [
          [wpNoApproval],
          [],  // batch fetch returns nothing
        ],
      });

      const result = await tickKatyaPublishExecutor(db as any);

      expect(result.checked).toBe(1);
      expect(result.blogsDiscovered).toBe(0);
      expect(result.socialsSubstituted).toBe(0);
      expect(db.update).not.toHaveBeenCalled();
    });
  });
});
