import { generateKeyPairSync, createVerify } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mutable fake config the module reads via loadConfig(). vi.hoisted so the
// vi.mock factory (hoisted above imports) can reference it.
const h = vi.hoisted(() => ({
  cfg: {
    githubAppId: "",
    githubAppInstallationId: "",
    githubAppPrivateKey: "",
    prReviewerBotLogin: "allyblockcast[bot]",
  } as Record<string, string>,
}));

vi.mock("../config.js", () => ({ loadConfig: () => h.cfg }));

import {
  mintAppJwt,
  getInstallationToken,
  githubHasReviewerEvidenceForPr,
  normalizeGithubLogin,
  _resetInstallationTokenCache,
} from "../services/github-app-auth.js";

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PRIVATE_KEY_PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const PUBLIC_KEY_PEM = publicKey.export({ type: "spki", format: "pem" }).toString();

function decodeB64UrlJson(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8"));
}

function jsonResponse(data: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => data } as unknown as Response;
}

const FUTURE_ISO = "2999-01-01T00:00:00Z";

function setCreds() {
  h.cfg.githubAppId = "3966421";
  h.cfg.githubAppInstallationId = "12345678";
  h.cfg.githubAppPrivateKey = PRIVATE_KEY_PEM;
  h.cfg.prReviewerBotLogin = "allyblockcast[bot]";
}

function clearCreds() {
  h.cfg.githubAppId = "";
  h.cfg.githubAppInstallationId = "";
  h.cfg.githubAppPrivateKey = "";
  h.cfg.prReviewerBotLogin = "allyblockcast[bot]";
}

beforeEach(() => {
  _resetInstallationTokenCache();
  clearCreds();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("normalizeGithubLogin", () => {
  it("strips @, app/, and [bot], lowercasing", () => {
    expect(normalizeGithubLogin("allyblockcast[bot]")).toBe("allyblockcast");
    expect(normalizeGithubLogin("app/AllyBlockcast")).toBe("allyblockcast");
    expect(normalizeGithubLogin("@Ally")).toBe("ally");
  });
});

describe("mintAppJwt", () => {
  it("returns null when app id / private key are unconfigured", () => {
    expect(mintAppJwt()).toBeNull();
  });

  it("mints a verifiable RS256 JWT with iss=appId and a forward exp", () => {
    setCreds();
    const nowMs = 1_700_000_000_000;
    const jwt = mintAppJwt(nowMs);
    expect(jwt).not.toBeNull();
    const [header, payload, signature] = jwt!.split(".");
    expect(decodeB64UrlJson(header)).toEqual({ alg: "RS256", typ: "JWT" });
    const claims = decodeB64UrlJson(payload);
    expect(claims.iss).toBe("3966421");
    expect(claims.iat).toBe(Math.floor(nowMs / 1000) - 30);
    expect(claims.exp).toBe(Math.floor(nowMs / 1000) + 540);

    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${header}.${payload}`);
    verifier.end();
    const sig = Buffer.from(signature.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    expect(verifier.verify(PUBLIC_KEY_PEM, sig)).toBe(true);
  });
});

describe("getInstallationToken", () => {
  it("returns null without creds", async () => {
    await expect(getInstallationToken()).resolves.toBeNull();
  });

  it("mints, returns, and caches the installation token", async () => {
    setCreds();
    const fetchMock = vi.fn(async (url: string | URL) => {
      expect(String(url)).toContain("/app/installations/12345678/access_tokens");
      return jsonResponse({ token: "ghs_test", expires_at: FUTURE_ISO });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(getInstallationToken()).resolves.toBe("ghs_test");
    // Second call is served from cache — no extra fetch.
    await expect(getInstallationToken()).resolves.toBe("ghs_test");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns null on a non-OK token response", async () => {
    setCreds();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ message: "bad" }, false, 401)));
    await expect(getInstallationToken()).resolves.toBeNull();
  });
});

describe("githubHasReviewerEvidenceForPr", () => {
  const repoFullName = "Blockcast/trafficcontrol";
  const prNumber = 752;
  const headSha = "45eb633e348a826f43dc68b0c25fe83a96300cea";

  function stubGithub(routes: {
    reviews?: unknown[];
    reviewsStatus?: number;
    comments?: unknown[];
    prHead?: string;
  }) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u.includes("/access_tokens")) return jsonResponse({ token: "ghs_test", expires_at: FUTURE_ISO });
        if (u.includes("/pulls/") && u.includes("/reviews")) {
          if (routes.reviewsStatus && routes.reviewsStatus >= 400) {
            return jsonResponse([], false, routes.reviewsStatus);
          }
          return jsonResponse(routes.reviews ?? []);
        }
        // BLO-10878: bare PR fetch used to resolve a missing head SHA.
        if (u.includes("/pulls/")) {
          return jsonResponse(routes.prHead !== undefined ? { head: { sha: routes.prHead } } : {});
        }
        if (u.includes("/issues/") && u.includes("/comments")) return jsonResponse(routes.comments ?? []);
        throw new Error(`unexpected url ${u}`);
      }),
    );
  }

  it("errors (no_token) when creds are absent so the caller falls back", async () => {
    await expect(githubHasReviewerEvidenceForPr({ repoFullName, prNumber, headSha })).resolves.toEqual({
      error: "no_token",
    });
  });

  it("finds a bot review at the exact head commit", async () => {
    setCreds();
    stubGithub({ reviews: [{ user: { login: "allyblockcast[bot]" }, commit_id: headSha }] });
    await expect(githubHasReviewerEvidenceForPr({ repoFullName, prNumber, headSha })).resolves.toEqual({
      found: true,
      via: "review",
    });
  });

  it("finds a bot comment that references the head SHA (comment-mode review)", async () => {
    setCreds();
    stubGithub({
      reviews: [],
      comments: [{ user: { login: "allyblockcast[bot]" }, body: `Reviewed at head ${headSha.slice(0, 12)} — LGTM.` }],
    });
    await expect(githubHasReviewerEvidenceForPr({ repoFullName, prNumber, headSha })).resolves.toEqual({
      found: true,
      via: "comment",
    });
  });

  it("BLO-10878: matches a comment-mode review when the head SHA is wrapped in markdown italics (trailing _)", async () => {
    setCreds();
    // Real paperclip#458 shape: Ally's consolidated review embeds the head SHA in
    // an italic run (`_reviewed head: <sha>_`), so a `_` sits immediately after the
    // final hex digit. `_` is a `\w` char, so a `\b…\b`-anchored pattern finds no
    // trailing word boundary and the review is mis-flagged as missing.
    stubGithub({
      reviews: [],
      comments: [
        { user: { login: "allyblockcast[bot]" }, body: `## Ally — Consolidated PR Review\n_reviewed head: ${headSha}_` },
      ],
    });
    await expect(githubHasReviewerEvidenceForPr({ repoFullName, prNumber, headSha })).resolves.toEqual({
      found: true,
      via: "comment",
    });
  });

  it("BLO-10878: falls back to the PR head when the wake carried no head SHA, then matches a comment-mode review", async () => {
    setCreds();
    stubGithub({
      prHead: headSha,
      reviews: [],
      comments: [{ user: { login: "allyblockcast[bot]" }, body: `## Ally — Consolidated PR Review  _reviewed head: ${headSha}` }],
    });
    await expect(githubHasReviewerEvidenceForPr({ repoFullName, prNumber, headSha: null })).resolves.toEqual({
      found: true,
      via: "comment",
    });
  });

  it("BLO-10878: keeps the lenient any-bot-review fallback when the head SHA can't be resolved", async () => {
    setCreds();
    // No head SHA on the wake and the PR fetch yields no head → the formal-review
    // loop still rescues on any bot review (unchanged pre-existing leniency).
    stubGithub({ reviews: [{ user: { login: "allyblockcast[bot]" }, commit_id: null }] });
    await expect(githubHasReviewerEvidenceForPr({ repoFullName, prNumber, headSha: null })).resolves.toEqual({
      found: true,
      via: "review",
    });
  });

  it("BLO-10878: returns not-found when the resolved PR head has no bot review or comment", async () => {
    setCreds();
    stubGithub({
      prHead: headSha,
      reviews: [],
      comments: [{ user: { login: "someone-else" }, body: headSha }],
    });
    await expect(githubHasReviewerEvidenceForPr({ repoFullName, prNumber, headSha: null })).resolves.toEqual({
      found: false,
    });
  });

  it("does not match a review by a different author or at a different head", async () => {
    setCreds();
    stubGithub({
      reviews: [
        { user: { login: "someone-else" }, commit_id: headSha },
        { user: { login: "allyblockcast[bot]" }, commit_id: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" },
      ],
      comments: [{ user: { login: "allyblockcast[bot]" }, body: "no sha referenced here" }],
    });
    await expect(githubHasReviewerEvidenceForPr({ repoFullName, prNumber, headSha })).resolves.toEqual({
      found: false,
    });
  });

  it("returns an error on a non-OK reviews response (caller keeps heuristic verdict)", async () => {
    setCreds();
    stubGithub({ reviewsStatus: 500 });
    await expect(githubHasReviewerEvidenceForPr({ repoFullName, prNumber, headSha })).resolves.toEqual({
      error: "reviews_http_500",
    });
  });
});
