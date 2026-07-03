import { describe, it, expect } from "vitest";
import { decideClaudeAuthSwitch, CLAUDE_SWITCH_PRIORITY } from "./types/claude-auth-switch.js";
import type { ClaudeAccountUsageSnapshot, ClaudeAccountTier } from "./types/claude-account-usage.js";

const NOW = "2026-07-01T00:00:00.000Z";
const HOUR = 3_600_000;

function iso(offsetHours: number, base = NOW): string {
  return new Date(Date.parse(base) + offsetHours * HOUR).toISOString();
}

function acct(
  profile: string,
  tier: ClaudeAccountTier,
  opts: {
    fiveHourPct?: number | null;
    sevenDayPct?: number | null;
    sevenDayResetsAt?: string | null;
    active?: boolean;
    source?: ClaudeAccountUsageSnapshot["source"];
  } = {},
): ClaudeAccountUsageSnapshot {
  return {
    profile,
    email: `${profile}@example.com`,
    subscriptionType: "max",
    tier,
    active: opts.active ?? false,
    fiveHour: opts.fiveHourPct === undefined ? { pct: 0, resetsAt: iso(3) } : { pct: opts.fiveHourPct, resetsAt: iso(3) },
    sevenDay:
      opts.sevenDayPct === undefined && opts.sevenDayResetsAt === undefined
        ? { pct: 0, resetsAt: iso(72) }
        : { pct: opts.sevenDayPct ?? 0, resetsAt: opts.sevenDayResetsAt ?? iso(72) },
    sevenDayOpus: null,
    sevenDaySonnet: null,
    probedAt: NOW,
    source: opts.source ?? (opts.active ? "live" : "snapshot"),
    error: null,
  };
}

describe("decideClaudeAuthSwitch", () => {
  it("burns a wameling account close to reset instead of sitting on a healthy OURS account", () => {
    const accounts = [
      acct("j-tuechler-twb-digital", "ours", { active: true, fiveHourPct: 20, sevenDayPct: 20 }),
      // 80% used, 7-day resets in 13h → use-it-or-lose-it (the ticket example).
      acct("ild-claude-web.de", "wameling", { fiveHourPct: 40, sevenDayPct: 80, sevenDayResetsAt: iso(13) }),
      // wameling far from reset → save it.
      acct("steven-i-love-design.de", "wameling", { fiveHourPct: 10, sevenDayPct: 10, sevenDayResetsAt: iso(120) }),
    ];
    const d = decideClaudeAuthSwitch({
      accounts,
      activeProfile: "j-tuechler-twb-digital",
      lastSwitchAt: null,
      now: NOW,
    });
    expect(d.action).toBe("switch");
    expect(d.targetProfile).toBe("ild-claude-web.de");
    expect(d.targetTier).toBe("wameling");
    const burn = d.candidates.find((c) => c.profile === "ild-claude-web.de");
    expect(burn?.priority).toBe(CLAUDE_SWITCH_PRIORITY.wamelingBurn);
  });

  it("falls back to an OURS account when no wameling account is near reset", () => {
    const accounts = [
      acct("j-tuechler-twb-digital", "ours", { active: false, fiveHourPct: 10, sevenDayPct: 10 }),
      acct("ild-claude-web.de", "wameling", { fiveHourPct: 10, sevenDayPct: 10, sevenDayResetsAt: iso(120) }),
      acct("steven-i-love-design.de", "wameling", { active: true, fiveHourPct: 95, sevenDayPct: 95, sevenDayResetsAt: iso(100) }),
    ];
    const d = decideClaudeAuthSwitch({
      accounts,
      activeProfile: "steven-i-love-design.de", // capped active → emergency switch
      lastSwitchAt: null,
      now: NOW,
    });
    expect(d.action).toBe("switch");
    expect(d.targetProfile).toBe("j-tuechler-twb-digital");
    expect(d.targetTier).toBe("ours");
  });

  it("holds when the active account is already the best target", () => {
    const accounts = [
      acct("j-tuechler-twb-digital", "ours", { active: true, fiveHourPct: 10, sevenDayPct: 10 }),
      acct("thomas", "ours", { fiveHourPct: 12, sevenDayPct: 12 }),
    ];
    const d = decideClaudeAuthSwitch({
      accounts,
      activeProfile: "j-tuechler-twb-digital",
      lastSwitchAt: null,
      now: NOW,
    });
    expect(d.action).toBe("hold");
    expect(d.targetProfile).toBeNull();
  });

  it("respects min-dwell for a healthy active account", () => {
    const accounts = [
      acct("j-tuechler-twb-digital", "ours", { active: true, fiveHourPct: 40, sevenDayPct: 40 }),
      acct("thomas", "ours", { fiveHourPct: 5, sevenDayPct: 5 }), // materially better but dwell blocks
    ];
    const d = decideClaudeAuthSwitch({
      accounts,
      activeProfile: "j-tuechler-twb-digital",
      lastSwitchAt: iso(-0.25), // 15 min ago < 45 min dwell
      now: NOW,
    });
    expect(d.action).toBe("hold");
    expect(d.reason).toMatch(/min-dwell/);
  });

  it("switches a capped active account immediately, bypassing dwell", () => {
    const accounts = [
      acct("steven-i-love-design.de", "wameling", { active: true, fiveHourPct: 99, sevenDayPct: 99, sevenDayResetsAt: iso(2) }),
      acct("j-tuechler-twb-digital", "ours", { fiveHourPct: 10, sevenDayPct: 10 }),
    ];
    const d = decideClaudeAuthSwitch({
      accounts,
      activeProfile: "steven-i-love-design.de",
      lastSwitchAt: iso(-0.1), // 6 min ago; dwell would normally block
      now: NOW,
    });
    expect(d.action).toBe("switch");
    expect(d.targetProfile).toBe("j-tuechler-twb-digital");
  });

  it("does not switch between two similar OURS accounts without a material margin", () => {
    const accounts = [
      acct("j-tuechler-twb-digital", "ours", { active: true, fiveHourPct: 30, sevenDayPct: 30 }),
      acct("thomas", "ours", { fiveHourPct: 25, sevenDayPct: 25 }), // only 5% better < 15% margin
    ];
    const d = decideClaudeAuthSwitch({
      accounts,
      activeProfile: "j-tuechler-twb-digital",
      lastSwitchAt: null,
      now: NOW,
    });
    expect(d.action).toBe("hold");
    expect(d.reason).toMatch(/materially/);
  });

  it("excludes an errored/unprobeable account from being a target", () => {
    const accounts = [
      acct("j-tuechler-twb-digital", "ours", { active: true, fiveHourPct: 96, sevenDayPct: 96 }),
      acct("thomas", "ours", { source: "error" }),
    ];
    const d = decideClaudeAuthSwitch({
      accounts,
      activeProfile: "j-tuechler-twb-digital",
      lastSwitchAt: null,
      now: NOW,
    });
    // active is capped, but the only alternative errored → nothing eligible → hold.
    expect(d.action).toBe("hold");
    expect(d.targetProfile).toBeNull();
  });

  it("prefers the soonest-resetting wameling account among burn candidates", () => {
    const accounts = [
      acct("j-tuechler-twb-digital", "ours", { active: true, fiveHourPct: 50, sevenDayPct: 50 }),
      acct("ild-claude-web.de", "wameling", { fiveHourPct: 30, sevenDayPct: 60, sevenDayResetsAt: iso(20) }),
      acct("ild-claude-2-web.de", "wameling", { fiveHourPct: 30, sevenDayPct: 60, sevenDayResetsAt: iso(5) }),
    ];
    const d = decideClaudeAuthSwitch({
      accounts,
      activeProfile: "j-tuechler-twb-digital",
      lastSwitchAt: null,
      now: NOW,
    });
    expect(d.action).toBe("switch");
    expect(d.targetProfile).toBe("ild-claude-2-web.de"); // resets in 5h, sooner
  });

  it("switches when there is no recorded active profile", () => {
    const accounts = [acct("j-tuechler-twb-digital", "ours", { fiveHourPct: 10, sevenDayPct: 10 })];
    const d = decideClaudeAuthSwitch({
      accounts,
      activeProfile: null,
      lastSwitchAt: null,
      now: NOW,
    });
    expect(d.action).toBe("switch");
    expect(d.targetProfile).toBe("j-tuechler-twb-digital");
  });
});
