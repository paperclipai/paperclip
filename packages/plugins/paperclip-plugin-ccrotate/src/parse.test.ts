import { describe, expect, it } from "vitest";
import { AVAIL_GLYPH_RE, parseWhenOutput, parseWhenRow } from "./parse.js";

describe("parseWhenRow availability glyphs", () => {
  // Regression for incident 2026-05-30: the 🤌 (api-limited / 429 cooldown)
  // glyph was missing from AVAIL_GLYPH_RE, so every api-limited row was
  // silently dropped — the paperclip pool view collapsed to the handful of
  // non-api-limited accounts while ccrotate-serve still listed them all.
  it("parses an api-limited (🤌) row instead of dropping it", () => {
    const line =
      "    ✓ 🤌 bot7@blockcast.net               exhausted·20x  5h:0% 7d:100%  opus cooldown 1809m11s · 429 unknown  api: opus cooldown 1809m11s · 429 unknown";
    const row = parseWhenRow(line);
    expect(row).not.toBeNull();
    expect(row!.email).toBe("bot7@blockcast.net");
    expect(row!.availMark).toBe("🤌");
    expect(row!.tier).toBe("exhausted·20x");
    expect(row!.util).toEqual({ u5: 0, u7: 100, s7d: null, o7d: null });
    expect(row!.apiLimit).toBe("opus cooldown 1809m11s · 429 unknown");
  });

  it("covers every glyph ccrotate's account-table.js can emit", () => {
    // Lockstep guard with lib/account-table.js renderAccountRow.
    for (const glyph of ["🟢", "🟡", "🔴", "🔵", "🤌", "⏳", "❔"]) {
      const row = parseWhenRow(`  ✓ ${glyph} a@b.com base 5h:1% 7d:2% usable now`);
      expect(row, `glyph ${glyph} should parse`).not.toBeNull();
      expect(row!.email).toBe("a@b.com");
      expect(AVAIL_GLYPH_RE.test(glyph)).toBe(true);
    }
  });

  it("still parses legacy rows with no availability glyph", () => {
    const row = parseWhenRow("★ ✓ a@b.com base 5h:64% 7d:22% usable now");
    expect(row).not.toBeNull();
    expect(row!.availMark).toBeNull();
    expect(row!.marker).toBe("★");
    expect(row!.email).toBe("a@b.com");
  });
});

describe("parseWhenOutput", () => {
  it("keeps api-limited rows alongside usable/exhausted ones", () => {
    // Active row starts with ★ at column 0; inactive rows are space-indented
    // (matches ccrotate account-table.js renderRow 'when' mode output).
    const stdout = [
      "Cache: 0min old",
      "",
      "★ ✓ 🟡 ssh-users+1@blockcast.net   base·20x   5h:100% 7d:43% in 31h9m  api: opus api ok",
      "  ✓ 🤌 bot4@blockcast.net          base·20x   5h:99% 7d:20%  opus cooldown 129m11s · 429 unknown  api: opus cooldown 129m11s · 429 unknown",
      "  ✓ ⏳ bot3@blockcast.net          exhausted·20x 5h:0% 7d:100% in 58h9m  api: opus api ok",
    ].join("\n");
    const { cacheAge, accounts } = parseWhenOutput("claude", stdout);
    expect(cacheAge).toBe("0min old");
    expect(accounts.map((a) => a.email)).toEqual([
      "ssh-users+1@blockcast.net",
      "bot4@blockcast.net",
      "bot3@blockcast.net",
    ]);
    expect(accounts.find((a) => a.email === "ssh-users+1@blockcast.net")?.isActive).toBe(true);
  });
});
