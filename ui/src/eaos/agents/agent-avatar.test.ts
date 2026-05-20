// @vitest-environment node
//
// LET-503 round-3 — pure-function coverage for the avatar token. The
// reviewer evidence relies on the token being stable for the same
// agent across surfaces, so the hash → palette mapping and the
// initials extraction need a regression guard.

import { describe, expect, it } from "vitest";
import { Bot, Code2, Cog, Crown, Palette, ShieldCheck, User } from "lucide-react";
import { getAgentAvatarToken } from "./agent-avatar";

describe("getAgentAvatarToken", () => {
  it("returns the same accent + initials for the same agent id across calls", () => {
    const a = getAgentAvatarToken({ kind: "agent", agentId: "id-1", name: "Avery Chen", role: "ceo" });
    const b = getAgentAvatarToken({ kind: "agent", agentId: "id-1", name: "Avery Chen", role: "ceo" });
    expect(a.accentBg).toBe(b.accentBg);
    expect(a.accentFg).toBe(b.accentFg);
    expect(a.initials).toBe(b.initials);
    expect(a.Glyph).toBe(b.Glyph);
  });

  it("picks two-character initials from name parts", () => {
    expect(
      getAgentAvatarToken({ kind: "agent", agentId: "id-x", name: "Avery Chen", role: "ceo" }).initials,
    ).toBe("AC");
    expect(
      getAgentAvatarToken({ kind: "agent", agentId: "id-y", name: "Solo", role: "engineer" }).initials,
    ).toBe("SO");
    expect(
      getAgentAvatarToken({ kind: "agent", agentId: "id-z", name: "Avery van der Meer", role: null }).initials,
    ).toBe("AM");
  });

  it("maps role to a role-appropriate lucide glyph", () => {
    expect(getAgentAvatarToken({ kind: "agent", agentId: "x", name: "X", role: "ceo" }).Glyph).toBe(Crown);
    expect(getAgentAvatarToken({ kind: "agent", agentId: "x", name: "X", role: "engineer" }).Glyph).toBe(Code2);
    expect(getAgentAvatarToken({ kind: "agent", agentId: "x", name: "X", role: "designer" }).Glyph).toBe(Palette);
    expect(getAgentAvatarToken({ kind: "agent", agentId: "x", name: "X", role: "security" }).Glyph).toBe(ShieldCheck);
    expect(getAgentAvatarToken({ kind: "agent", agentId: "x", name: "X", role: "unknown-role" }).Glyph).toBe(Bot);
  });

  it("uses User glyph + tinted palette for human teammates", () => {
    const t = getAgentAvatarToken({ kind: "user", userId: "u-1", name: "Andrii K." });
    expect(t.tone).toBe("user");
    expect(t.Glyph).toBe(User);
    expect(t.initials).toBe("AK");
    expect(t.ariaLabel).toContain("Andrii K.");
  });

  it("uses Cog + neutral palette for system actor", () => {
    const t = getAgentAvatarToken({ kind: "system" });
    expect(t.tone).toBe("system");
    expect(t.Glyph).toBe(Cog);
    expect(t.initials).toBe("··");
  });

  it("encodes the role in the agent aria-label so screen readers get the role", () => {
    const t = getAgentAvatarToken({ kind: "agent", agentId: "a-1", name: "Marcus Hall", role: "engineer" });
    expect(t.ariaLabel.toLowerCase()).toContain("agent");
    expect(t.ariaLabel.toLowerCase()).toContain("engineer");
    expect(t.ariaLabel).toContain("Marcus Hall");
  });
});
