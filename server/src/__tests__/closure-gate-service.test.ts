import { describe, expect, it } from "vitest";
import {
  CLOSURE_GATE_FIX_SHA_LINE_REGEX,
  CLOSURE_GATE_VERIFY_CACHE_TTL_MS,
} from "@paperclipai/shared";
import {
  createClosureGate,
  createClosureGateCache,
  extractFixSha,
  parseLsRemoteOutput,
  verifyFixShaOnRemote,
  throwIfClosureGateRejected,
} from "../services/closure-gate.js";
import { HttpError } from "../errors.js";

const REAL_SHA = "abcdef0123456789abcdef0123456789abcdef01";
const FAKE_SHA = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

describe("extractFixSha", () => {
  it("returns null for empty input", () => {
    expect(extractFixSha("")).toBeNull();
    expect(extractFixSha(null)).toBeNull();
    expect(extractFixSha(undefined)).toBeNull();
  });

  it("parses a Fix-SHA line and defaults target to main", () => {
    const out = extractFixSha(`Done.\n\nFix-SHA: ${REAL_SHA}\n`);
    expect(out).toEqual({ sha: REAL_SHA, target: "main" });
  });

  it("lowercases the SHA so case-insensitive comparison works", () => {
    const upper = REAL_SHA.toUpperCase();
    const out = extractFixSha(`Fix-SHA: ${upper}`);
    expect(out?.sha).toBe(REAL_SHA);
  });

  it("parses the optional Fix-Target line", () => {
    const out = extractFixSha(`Fix-SHA: ${REAL_SHA}\nFix-Target: feature/CAR-214\n`);
    expect(out).toEqual({ sha: REAL_SHA, target: "feature/CAR-214" });
  });

  it("returns null when no Fix-SHA line is present", () => {
    expect(extractFixSha(`All done, merged to main.\nFix-PR: 42\n`)).toBeNull();
  });

  it("returns null when the SHA is the wrong length", () => {
    expect(extractFixSha(`Fix-SHA: ${REAL_SHA.slice(0, 39)}\n`)).toBeNull();
  });
});

describe("parseLsRemoteOutput", () => {
  it("parses well-formed ls-remote output", () => {
    const out = parseLsRemoteOutput(
      `${REAL_SHA}\trefs/heads/main\n${FAKE_SHA}\trefs/heads/feature/x\n`,
    );
    expect(out.size).toBe(2);
    expect(out.has(REAL_SHA)).toBe(true);
    expect(out.has(FAKE_SHA)).toBe(true);
  });

  it("ignores blank and malformed lines", () => {
    const out = parseLsRemoteOutput(
      `\n${REAL_SHA}\trefs/heads/main\nnot-a-sha\trefs/heads/x\n${REAL_SHA.slice(0, 10)}\trefs/heads/bad\n`,
    );
    expect(out.size).toBe(1);
    expect(out.has(REAL_SHA)).toBe(true);
  });
});

describe("verifyFixShaOnRemote", () => {
  it("verifies a reachable SHA from fresh fetch", async () => {
    const fetchImpl = async () => new Set([REAL_SHA]);
    const res = await verifyFixShaOnRemote({
      repoUrl: "https://example.com/repo.git",
      target: "main",
      sha: REAL_SHA,
      fetchImpl,
    });
    expect(res).toEqual({ ok: true, source: "fresh" });
  });

  it("rejects an unreachable SHA from fresh fetch", async () => {
    const fetchImpl = async () => new Set([REAL_SHA]);
    const res = await verifyFixShaOnRemote({
      repoUrl: "https://example.com/repo.git",
      target: "main",
      sha: FAKE_SHA,
      fetchImpl,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("unreachable_sha");
  });

  it("caches successful fetches and reports source: cache on second call", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return new Set([REAL_SHA]);
    };
    const cache = createClosureGateCache(60_000);
    const first = await verifyFixShaOnRemote({
      repoUrl: "https://example.com/repo.git",
      target: "main",
      sha: REAL_SHA,
      fetchImpl,
      cache,
    });
    const second = await verifyFixShaOnRemote({
      repoUrl: "https://example.com/repo.git",
      target: "main",
      sha: REAL_SHA,
      fetchImpl,
      cache,
    });
    expect(first).toEqual({ ok: true, source: "fresh" });
    expect(second).toEqual({ ok: true, source: "cache" });
    expect(calls).toBe(1);
  });

  it("returns git_error when fetch throws", async () => {
    const fetchImpl = async () => {
      throw new Error("connection refused");
    };
    const res = await verifyFixShaOnRemote({
      repoUrl: "https://example.com/repo.git",
      target: "main",
      sha: REAL_SHA,
      fetchImpl,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("git_error");
  });
});

describe("createClosureGate.assertAllowed — mode: off", () => {
  const gate = createClosureGate();

  it("is a no-op for any actor or comment", async () => {
    const out = await gate.assertAllowed({
      companyMode: "off",
      actor: { actorType: "agent", agentId: "a" },
      commentBody: null,
      resolveRepoUrl: async () => "https://example.com/repo.git",
    });
    expect(out.allowed).toBe(true);
    if (!out.allowed) return;
    expect(out.fixSha).toBeNull();
  });
});

describe("createClosureGate.assertAllowed — mode: enforce", () => {
  it("allows a board (user) actor without requiring a Fix-SHA", async () => {
    const gate = createClosureGate();
    const out = await gate.assertAllowed({
      companyMode: "enforce",
      actor: { actorType: "user" },
      commentBody: null,
      resolveRepoUrl: async () => "https://example.com/repo.git",
    });
    expect(out.allowed).toBe(true);
  });

  it("rejects an agent with no Fix-SHA in comment body", async () => {
    const gate = createClosureGate();
    const out = await gate.assertAllowed({
      companyMode: "enforce",
      actor: { actorType: "agent", agentId: "agent-1" },
      commentBody: "All done, merged via PR.",
      resolveRepoUrl: async () => "https://example.com/repo.git",
    });
    expect(out.allowed).toBe(false);
    if (out.allowed) return;
    expect(out.reason).toBe("missing_fix_sha");
    expect(out.message).toMatch(/Fix-SHA/);
  });

  it("rejects an agent with no Fix-SHA when fallback comment also lacks one", async () => {
    const gate = createClosureGate();
    const out = await gate.assertAllowed({
      companyMode: "enforce",
      actor: { actorType: "agent", agentId: "agent-1" },
      commentBody: null,
      fallbackCommentBody: "Earlier progress comment with no SHA.",
      resolveRepoUrl: async () => "https://example.com/repo.git",
    });
    expect(out.allowed).toBe(false);
    if (out.allowed) return;
    expect(out.reason).toBe("missing_fix_sha");
  });

  it("accepts an agent with a reachable SHA in the closure comment", async () => {
    const fetchImpl = async () => new Set([REAL_SHA]);
    const gate = createClosureGate({ fetchImpl });
    const out = await gate.assertAllowed({
      companyMode: "enforce",
      actor: { actorType: "agent", agentId: "agent-1" },
      commentBody: `Done.\n\nFix-SHA: ${REAL_SHA}\nFix-Target: main\n`,
      resolveRepoUrl: async () => "https://example.com/repo.git",
    });
    expect(out.allowed).toBe(true);
    if (!out.allowed) return;
    expect(out.fixSha?.sha).toBe(REAL_SHA);
    expect(out.verified).toBe("fresh");
  });

  it("rejects an agent when the SHA is not reachable on the target branch", async () => {
    const fetchImpl = async () => new Set([REAL_SHA]);
    const gate = createClosureGate({ fetchImpl });
    const out = await gate.assertAllowed({
      companyMode: "enforce",
      actor: { actorType: "agent", agentId: "agent-1" },
      commentBody: `Done.\n\nFix-SHA: ${FAKE_SHA}\n`,
      resolveRepoUrl: async () => "https://example.com/repo.git",
    });
    expect(out.allowed).toBe(false);
    if (out.allowed) return;
    expect(out.reason).toBe("unreachable_sha");
  });

  it("rejects when company has no configured repo URL", async () => {
    const gate = createClosureGate();
    const out = await gate.assertAllowed({
      companyMode: "enforce",
      actor: { actorType: "agent", agentId: "agent-1" },
      commentBody: `Fix-SHA: ${REAL_SHA}\n`,
      resolveRepoUrl: async () => null,
    });
    expect(out.allowed).toBe(false);
    if (out.allowed) return;
    expect(out.reason).toBe("git_error");
  });

  it("reads Fix-SHA from the fallback comment when current body lacks it", async () => {
    const fetchImpl = async () => new Set([REAL_SHA]);
    const gate = createClosureGate({ fetchImpl });
    const out = await gate.assertAllowed({
      companyMode: "enforce",
      actor: { actorType: "agent", agentId: "agent-1" },
      commentBody: null,
      fallbackCommentBody: `Earlier merge with SHA.\n\nFix-SHA: ${REAL_SHA}\n`,
      resolveRepoUrl: async () => "https://example.com/repo.git",
    });
    expect(out.allowed).toBe(true);
  });
});

describe("createClosureGate.assertAllowed — mode: advisory", () => {
  it("logs warning but allows an agent without a Fix-SHA", async () => {
    const warnings: Array<{ msg: string; payload: Record<string, unknown> }> = [];
    const logger = {
      warn: (payload: Record<string, unknown>, msg: string) => {
        warnings.push({ msg, payload });
      },
    };
    const gate = createClosureGate({ logger });
    const out = await gate.assertAllowed({
      companyMode: "advisory",
      actor: { actorType: "agent", agentId: "agent-1" },
      commentBody: "merged but no sha",
      resolveRepoUrl: async () => "https://example.com/repo.git",
    });
    expect(out.allowed).toBe(true);
    expect(warnings.some((w) => w.payload.reason === "missing_fix_sha")).toBe(true);
  });

  it("logs warning but allows an agent with unreachable SHA", async () => {
    const warnings: Array<{ msg: string; payload: Record<string, unknown> }> = [];
    const logger = {
      warn: (payload: Record<string, unknown>, msg: string) => {
        warnings.push({ msg, payload });
      },
    };
    const fetchImpl = async () => new Set([REAL_SHA]);
    const gate = createClosureGate({ logger, fetchImpl });
    const out = await gate.assertAllowed({
      companyMode: "advisory",
      actor: { actorType: "agent", agentId: "agent-1" },
      commentBody: `Fix-SHA: ${FAKE_SHA}\n`,
      resolveRepoUrl: async () => "https://example.com/repo.git",
    });
    expect(out.allowed).toBe(true);
    expect(warnings.some((w) => w.payload.reason === "unreachable_sha")).toBe(true);
  });
});

describe("throwIfClosureGateRejected", () => {
  it("throws an HttpError(422) for a rejected outcome", () => {
    expect(() =>
      throwIfClosureGateRejected({
        allowed: false,
        mode: "enforce",
        reason: "missing_fix_sha",
        message: "needs Fix-SHA",
      }),
    ).toThrow(HttpError);
    try {
      throwIfClosureGateRejected({
        allowed: false,
        mode: "enforce",
        reason: "missing_fix_sha",
        message: "needs Fix-SHA",
      });
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).status).toBe(422);
    }
  });

  it("is a no-op for an allowed outcome", () => {
    expect(() =>
      throwIfClosureGateRejected({
        allowed: true,
        mode: "enforce",
        fixSha: { sha: REAL_SHA, target: "main" },
        verified: "fresh",
      }),
    ).not.toThrow();
  });
});

describe("closure-gate constants integration", () => {
  it("uses the shared regex from @paperclipai/shared", () => {
    expect(CLOSURE_GATE_FIX_SHA_LINE_REGEX).toBeInstanceOf(RegExp);
    const m = CLOSURE_GATE_FIX_SHA_LINE_REGEX.exec(`Fix-SHA: ${REAL_SHA}\nFix-Target: dev\n`);
    expect(m?.[1]).toBe(REAL_SHA);
    expect(m?.[2]).toBe("dev");
  });

  it("uses the shared cache TTL constant", () => {
    expect(typeof CLOSURE_GATE_VERIFY_CACHE_TTL_MS).toBe("number");
    expect(CLOSURE_GATE_VERIFY_CACHE_TTL_MS).toBe(60_000);
  });
});
