import { describe, it, expect, vi, afterEach } from "vitest";
import { buildDenylistRegex, createTripwireChecker } from "./denylist-tripwire.js";

// Fixture mirrors the v1.0 denylist (all HARD-BLOCK + REJECT rows, no Overrides/Changelog).
const FIXTURE_DENYLIST = `# Sage Surfaces — Tooling Denylist

## HARD-BLOCK

| Repo / Vendor | License | Reason | Sweep / Source |
|---|---|---|---|
| \`CloakHQ/CloakBrowser\` | MIT | stealth Chromium | |
| \`AIDC-AI/Pixelle-Video\` | Apache-2.0 | PRC vendor | |
| \`bytedance/UI-TARS-desktop\` | — | PRC vendor | |
| \`deepseek-ai/*\` (weights + repos) | — | PRC vendor | |
| \`llm-abliteration\` | — | safety-bypass tooling | |
| \`hermes-agent-self-evolution\` | — | self-modifying agent | |
| \`system_prompts_leaks\` | — | exfiltrated prompts | |
| \`ds2api\` | — | DeepSeek API wrapper | |
| \`tinyhumansai/openhuman\` | GPL-3.0 | keylogger deps | |
| \`ruvnet/ruflo\` | — | supply-chain attack | |
| \`Moonshot AI / Kimi\` (\`code.kimi.com\`, \`kimi\` CLI runtime) | — | PRC vendor | |
| \`ruvnet/RuView\` | MIT | maintainer-taint | |
| \`MiniMax-AI/skills\` (and \`MiniMax-AI/*\`) | MIT | PRC vendor | |
| \`decolua/9router\` | TBD | TOS arbitrage | |
| \`Alishahryar1/free-claude-code\` | TBD | Anthropic TOS violation | |

## REJECT (license)

| Repo | License | Reason | Sweep / Source |
|---|---|---|---|
| \`manaflow-ai/cmux\` | GPL-3.0-or-later | copyleft | |
| \`Imbad0202/academic-research-skills\` | CC BY-NC 4.0 | non-commercial | |
| \`hesreallyhim/awesome-claude-code\` | CC BY-NC-ND 4.0 | non-commercial + no-deriv | |
| \`Anil-matcha/Open-Generative-AI\` | (no license) | no license | |
| \`NirDiamant/agents-towards-production\` | non-commercial | proprietary | |

## Overrides

(None.)

## Changelog

- \`some-changelog-repo\` should NOT appear in patterns.
`;

describe("buildDenylistRegex", () => {
  it("returns a non-null regex from valid fixture content", () => {
    expect(buildDenylistRegex(FIXTURE_DENYLIST)).not.toBeNull();
  });

  it("returns null for empty content", () => {
    expect(buildDenylistRegex("")).toBeNull();
  });

  it("returns null for content with no parseable table rows", () => {
    expect(buildDenylistRegex("# Title\n\nNo tables here.\n")).toBeNull();
  });

  describe("HARD-BLOCK pattern coverage (spot-check ≥5)", () => {
    let regex: RegExp;
    beforeAll(() => {
      regex = buildDenylistRegex(FIXTURE_DENYLIST)!;
    });

    it("matches CloakHQ/CloakBrowser", () => {
      expect(regex.test("npm install CloakHQ/CloakBrowser")).toBe(true);
    });

    it("matches deepseek-ai/* wildcard — deepseek-ai/deepseek-coder", () => {
      expect(regex.test("pip install deepseek-ai/deepseek-coder")).toBe(true);
    });

    it("matches deepseek-ai/* wildcard — exact namespace", () => {
      expect(regex.test("git clone deepseek-ai/anything")).toBe(true);
    });

    it("matches ruvnet/ruflo", () => {
      expect(regex.test("npm install ruvnet/ruflo")).toBe(true);
    });

    it("matches MiniMax-AI/skills", () => {
      expect(regex.test("npm install MiniMax-AI/skills")).toBe(true);
    });

    it("matches MiniMax-AI/* wildcard", () => {
      expect(regex.test("pip install MiniMax-AI/some-other-package")).toBe(true);
    });

    it("matches Moonshot AI / Kimi (case-insensitive)", () => {
      expect(regex.test("install moonshot ai / kimi")).toBe(true);
    });

    it("matches ruvnet/RuView (maintainer-taint)", () => {
      expect(regex.test("npm install ruvnet/RuView")).toBe(true);
    });

    it("matches bytedance/UI-TARS-desktop", () => {
      expect(regex.test("git clone bytedance/UI-TARS-desktop")).toBe(true);
    });

    it("matches llm-abliteration", () => {
      expect(regex.test("pip install llm-abliteration")).toBe(true);
    });
  });

  describe("REJECT pattern coverage", () => {
    let regex: RegExp;
    beforeAll(() => {
      regex = buildDenylistRegex(FIXTURE_DENYLIST)!;
    });

    it("matches manaflow-ai/cmux", () => {
      expect(regex.test("npm install manaflow-ai/cmux")).toBe(true);
    });

    it("matches hesreallyhim/awesome-claude-code", () => {
      expect(regex.test("npm install hesreallyhim/awesome-claude-code")).toBe(true);
    });

    it("matches NirDiamant/agents-towards-production", () => {
      expect(regex.test("pip install NirDiamant/agents-towards-production")).toBe(true);
    });
  });

  describe("non-matching commands", () => {
    let regex: RegExp;
    beforeAll(() => {
      regex = buildDenylistRegex(FIXTURE_DENYLIST)!;
    });

    it("does not match npm install lodash", () => {
      expect(regex.test("npm install lodash")).toBe(false);
    });

    it("does not match git clone some-other/repo", () => {
      expect(regex.test("git clone https://github.com/some-other/repo")).toBe(false);
    });

    it("does not match an unrelated pip install", () => {
      expect(regex.test("pip install requests")).toBe(false);
    });
  });

  describe("Changelog rows excluded", () => {
    it("does not match some-changelog-repo", () => {
      const regex = buildDenylistRegex(FIXTURE_DENYLIST)!;
      expect(regex.test("npm install some-changelog-repo")).toBe(false);
    });
  });
});

describe("createTripwireChecker", () => {
  const BASE_CTX = {
    command: "npm",
    args: ["install", "ruvnet/ruflo"],
    issueId: "SAG-0000",
    agentId: "agent-test",
    adapterType: "claude_local" as const,
  };

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.PAPERCLIP_DENYLIST_TRIPWIRE;
    delete process.env.PAPERCLIP_API_URL;
    delete process.env.PAPERCLIP_COMPANY_ID;
    delete process.env.PAPERCLIP_API_KEY;
  });

  it("logs to stderr and fires API alerts on a matching command", async () => {
    const regex = buildDenylistRegex(FIXTURE_DENYLIST)!;
    const checker = createTripwireChecker(regex);

    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(new Response());
    process.env.PAPERCLIP_API_URL = "http://localhost:3100";
    process.env.PAPERCLIP_COMPANY_ID = "test-company";
    process.env.PAPERCLIP_API_KEY = "test-key";

    await checker(BASE_CTX);

    expect(stderrSpy).toHaveBeenCalledOnce();
    const logged = JSON.parse(stderrSpy.mock.calls[0][0] as string);
    expect(logged.event).toBe("denylist_tripwire");
    expect(logged.agentId).toBe("agent-test");
    expect(logged.adapterType).toBe("claude_local");
    expect(logged.issueId).toBe("SAG-0000");
    expect(typeof logged.matchedPattern).toBe("string");
    expect(typeof logged.timestamp).toBe("string");

    // Two fetch calls: one for CTO, one for CEO
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const [url0, opts0] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url0).toBe("http://localhost:3100/api/companies/test-company/issues");
    expect(opts0.method).toBe("POST");
    const body0 = JSON.parse(opts0.body as string);
    expect(body0.priority).toBe("high");
    expect(body0.title).toContain("[TRIPWIRE]");
    expect(body0.assigneeAgentId).toBe("f3c48afc-c339-4e43-b47b-a42a0891229d"); // CTO

    const body1 = JSON.parse((fetchSpy.mock.calls[1] as [string, RequestInit])[1].body as string);
    expect(body1.assigneeAgentId).toBe("b0f67cc2-259e-477b-ac89-d0ff4e7c8e89"); // CEO
  });

  it("does not log or call fetch for a non-matching command", async () => {
    const regex = buildDenylistRegex(FIXTURE_DENYLIST)!;
    const checker = createTripwireChecker(regex);

    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(new Response());

    await checker({ ...BASE_CTX, command: "npm", args: ["install", "lodash"] });

    expect(stderrSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not log or call fetch when PAPERCLIP_DENYLIST_TRIPWIRE=false", async () => {
    const regex = buildDenylistRegex(FIXTURE_DENYLIST)!;
    const checker = createTripwireChecker(regex);

    process.env.PAPERCLIP_DENYLIST_TRIPWIRE = "false";
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(new Response());

    // command would match ruvnet/ruflo without the kill switch
    await checker(BASE_CTX);

    expect(stderrSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does nothing when regex is null (file not found)", async () => {
    const checker = createTripwireChecker(null);

    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(new Response());

    await checker(BASE_CTX);

    expect(stderrSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("skips fetch when API env vars are not set", async () => {
    const regex = buildDenylistRegex(FIXTURE_DENYLIST)!;
    const checker = createTripwireChecker(regex);

    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(new Response());

    await checker(BASE_CTX);

    expect(stderrSpy).toHaveBeenCalledOnce(); // log still fires
    expect(fetchSpy).not.toHaveBeenCalled();  // no API vars → no fetch
  });

  it("includes X-Paperclip-Run-Id header when PAPERCLIP_RUN_ID is set", async () => {
    const regex = buildDenylistRegex(FIXTURE_DENYLIST)!;
    const checker = createTripwireChecker(regex);

    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(new Response());
    process.env.PAPERCLIP_API_URL = "http://localhost:3100";
    process.env.PAPERCLIP_COMPANY_ID = "test-company";
    process.env.PAPERCLIP_API_KEY = "test-key";
    process.env.PAPERCLIP_RUN_ID = "run-abc";

    await checker(BASE_CTX);

    const opts = (fetchSpy.mock.calls[0] as [string, RequestInit])[1];
    expect((opts.headers as Record<string, string>)["X-Paperclip-Run-Id"]).toBe("run-abc");

    delete process.env.PAPERCLIP_RUN_ID;
  });

  it("opencode_local: deepseek-ai wildcard match triggers log with correct adapterType", async () => {
    const regex = buildDenylistRegex(FIXTURE_DENYLIST)!;
    const checker = createTripwireChecker(regex);

    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    vi.spyOn(global, "fetch").mockResolvedValue(new Response());

    await checker({
      command: "pip",
      args: ["install", "deepseek-ai/deepseek-coder"],
      issueId: null,
      agentId: "agent-oc",
      adapterType: "opencode_local",
    });

    expect(stderrSpy).toHaveBeenCalledOnce();
    const logged = JSON.parse(stderrSpy.mock.calls[0][0] as string);
    expect(logged.adapterType).toBe("opencode_local");
    expect(logged.issueId).toBeNull();
  });
});

// needed for describe blocks that use beforeAll
import { beforeAll } from "vitest";
