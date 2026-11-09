import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ claude: vi.fn(), codex: vi.fn() }));
vi.mock("@paperclipai/adapter-claude-local/server", () => ({ readClaudeAuthStatus: mocks.claude }));
vi.mock("@paperclipai/adapter-codex-local/server", () => ({ readCodexAuthInfo: mocks.codex }));
import { readLocalCliAuthSignal } from "../services/local-cli-auth.js";

describe("local CLI subscription detection", () => {
  beforeEach(() => vi.resetAllMocks());
  it("recognizes Claude subscription auth but not API key auth", async () => {
    mocks.claude.mockResolvedValue({ loggedIn: true, authMethod: "claude.ai" });
    expect(await readLocalCliAuthSignal("claude_local")).toBe("present");
    mocks.claude.mockResolvedValue({ loggedIn: true, authMethod: "api_key" });
    expect(await readLocalCliAuthSignal("claude_local")).toBe("absent");
    mocks.claude.mockResolvedValue({ loggedIn: false, authMethod: null });
    expect(await readLocalCliAuthSignal("claude_local")).toBe("absent");
  });
  it("returns only a signal for a Codex login", async () => {
    mocks.codex.mockResolvedValue({ accessToken: "fixture-secret" });
    expect(await readLocalCliAuthSignal("codex_local")).toBe("present");
    mocks.codex.mockResolvedValue(null);
    expect(await readLocalCliAuthSignal("codex_local")).toBe("absent");
  });
  it("leaves login available when a CLI cannot be checked", async () => {
    mocks.claude.mockResolvedValue(null);
    mocks.codex.mockRejectedValue(new Error("unreadable"));
    expect(await readLocalCliAuthSignal("claude_local")).toBe("unknown");
    expect(await readLocalCliAuthSignal("codex_local")).toBe("unknown");
  });
});
