import { describe, expect, it, vi } from "vitest";
import { issueService } from "../services/issues.js";

/**
 * Build a minimal mock Db that returns the given agent rows for any
 * `db.select().from(agents).where(...)` chain.
 */
function makeDb(agentRows: Array<{ id: string; name: string }>) {
  const terminal = Object.assign(Promise.resolve(agentRows), {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
  });
  return { select: vi.fn().mockReturnValue(terminal) } as any;
}

const AGENTS = [
  { id: "1", name: "CEO" },
  { id: "2", name: "CTO" },
  { id: "3", name: "Engineering Manager" },
  { id: "4", name: "iOS Dev" },
  { id: "5", name: "Content Lead" },
  { id: "6", name: "Writer" },
  { id: "7", name: "Tech Researcher" },
  { id: "8", name: "Monitor" },
  { id: "9", name: "ASO Lead" },
  { id: "10", name: "Social Manager" },
];

const COMPANY = "company-1";

describe("findMentionedAgents", () => {
  function build() {
    return issueService(makeDb(AGENTS));
  }

  // ── single-word names ──────────────────────────────────────────────
  it("matches a single-word agent name", async () => {
    const svc = build();
    const ids = await svc.findMentionedAgents(COMPANY, "@CEO please review");
    expect(ids).toEqual(["1"]);
  });

  it("matches Writer at end of string", async () => {
    const svc = build();
    const ids = await svc.findMentionedAgents(COMPANY, "assigned to @Writer");
    expect(ids).toEqual(["6"]);
  });

  // ── multi-word names ───────────────────────────────────────────────
  it("matches a two-word agent name", async () => {
    const svc = build();
    const ids = await svc.findMentionedAgents(COMPANY, "@iOS Dev fix the bug");
    expect(ids).toEqual(["4"]);
  });

  it("matches a two-word agent name at end of string", async () => {
    const svc = build();
    const ids = await svc.findMentionedAgents(COMPANY, "please review @Content Lead");
    expect(ids).toEqual(["5"]);
  });

  it("matches a two-word name followed by punctuation", async () => {
    const svc = build();
    const ids = await svc.findMentionedAgents(COMPANY, "@Engineering Manager, please look");
    expect(ids).toEqual(["3"]);
  });

  it("matches a two-word name followed by em-dash", async () => {
    const svc = build();
    const ids = await svc.findMentionedAgents(COMPANY, "@Tech Researcher—findings attached");
    expect(ids).toEqual(["7"]);
  });

  // ── multiple mentions in one body ──────────────────────────────────
  it("matches multiple agents in one comment", async () => {
    const svc = build();
    const ids = await svc.findMentionedAgents(
      COMPANY,
      "@CEO and @iOS Dev need to coordinate with @Engineering Manager",
    );
    expect(ids).toContain("1");
    expect(ids).toContain("4");
    expect(ids).toContain("3");
    expect(ids).toHaveLength(3);
  });

  it("matches mix of single-word and multi-word names", async () => {
    const svc = build();
    const ids = await svc.findMentionedAgents(
      COMPANY,
      "@CTO check @Tech Researcher findings",
    );
    expect(ids).toContain("2");
    expect(ids).toContain("7");
    expect(ids).toHaveLength(2);
  });

  // ── no false positives ─────────────────────────────────────────────
  it("returns empty for no mentions", async () => {
    const svc = build();
    const ids = await svc.findMentionedAgents(COMPANY, "no mentions here");
    expect(ids).toEqual([]);
  });

  it("does not match partial agent names", async () => {
    const svc = build();
    // "iOS Developer" is not "iOS Dev"
    const ids = await svc.findMentionedAgents(COMPANY, "@iOS Developer submitted PR");
    expect(ids).toEqual([]);
  });

  it("does not match substring of a word", async () => {
    const svc = build();
    // "Engineering" alone is not an agent name
    const ids = await svc.findMentionedAgents(COMPANY, "the @Engineering team rocks");
    expect(ids).toEqual([]);
  });

  // ── case insensitivity ─────────────────────────────────────────────
  it("matches case-insensitively", async () => {
    const svc = build();
    const ids = await svc.findMentionedAgents(COMPANY, "@ceo and @ios dev");
    expect(ids).toContain("1");
    expect(ids).toContain("4");
  });

  // ── no duplicates ─────────────────────────────────────────────────
  it("does not return duplicates when agent is mentioned twice", async () => {
    const svc = build();
    const ids = await svc.findMentionedAgents(
      COMPANY,
      "@iOS Dev please fix. @iOS Dev this is urgent",
    );
    expect(ids).toEqual(["4"]);
  });

  // ── no agents in company ──────────────────────────────────────────
  it("returns empty when company has no agents", async () => {
    const svc = issueService(makeDb([]));
    const ids = await svc.findMentionedAgents(COMPANY, "@CEO hello");
    expect(ids).toEqual([]);
  });

  // ── boundary: @ at very start ─────────────────────────────────────
  it("matches mention at the very start of the body", async () => {
    const svc = build();
    const ids = await svc.findMentionedAgents(COMPANY, "@Social Manager draft needed");
    expect(ids).toEqual(["10"]);
  });

  // ── boundary: exclamation mark ────────────────────────────────────
  it("matches mention followed by exclamation mark", async () => {
    const svc = build();
    const ids = await svc.findMentionedAgents(COMPANY, "Hey @ASO Lead! Review keywords");
    expect(ids).toEqual(["9"]);
  });

  // ── email-like false positives ────────────────────────────────────
  it("does not match @ embedded in an email-like substring", async () => {
    const svc = build();
    const ids = await svc.findMentionedAgents(COMPANY, "email dev@iOS Dev for details");
    expect(ids).toEqual([]);
  });

  it("does not match @ preceded by a word character", async () => {
    const svc = build();
    const ids = await svc.findMentionedAgents(COMPANY, "user123@CEO is not a mention");
    expect(ids).toEqual([]);
  });

  it("matches @ after punctuation (not a word character)", async () => {
    const svc = build();
    const ids = await svc.findMentionedAgents(COMPANY, "see (@iOS Dev) for details");
    expect(ids).toEqual(["4"]);
  });
});
