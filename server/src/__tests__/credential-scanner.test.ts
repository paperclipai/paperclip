import { describe, it, expect, beforeEach } from "vitest";
import { scanAndRedact, resetScannerRuleCache } from "../credential-scanner.js";

// All credential-shaped strings below are SYNTHETIC: correct prefix + random suffix.
// No real credentials are used anywhere in this file.

beforeEach(() => {
  resetScannerRuleCache();
});

describe("credential-scanner: GitHub tokens", () => {
  it("redacts ghp_ PAT and preserves surrounding text", () => {
    const token = "ghp_" + "A".repeat(36);
    const input = `See token: ${token} and continue.`;
    const { text, matches } = scanAndRedact(input);
    expect(text).not.toContain(token);
    expect(text).toContain("[REDACTED:SH-12:GH_PAT]");
    expect(text).toContain("See token:");
    expect(text).toContain("and continue.");
    expect(matches).toHaveLength(1);
    expect(matches[0].typeHint).toBe("GH_PAT");
    expect(matches[0].inputLength).toBe(token.length);
  });

  it("redacts ghs_ app secret", () => {
    const token = "ghs_" + "B".repeat(36);
    const { text, matches } = scanAndRedact(`secret=${token}`);
    expect(text).not.toContain(token);
    expect(text).toContain("[REDACTED:SH-12:GH_APP_SECRET]");
    expect(matches[0].typeHint).toBe("GH_APP_SECRET");
  });

  it("redacts gho_ OAuth token", () => {
    const token = "gho_" + "C".repeat(36);
    const { text } = scanAndRedact(token);
    expect(text).toBe("[REDACTED:SH-12:GH_OAUTH]");
  });

  it("redacts ghr_ refresh token", () => {
    const token = "ghr_" + "D".repeat(36);
    const { text } = scanAndRedact(token);
    expect(text).toBe("[REDACTED:SH-12:GH_REFRESH]");
  });

  it("does not redact ghp_ with too-short suffix", () => {
    const shortToken = "ghp_" + "X".repeat(10);
    const { text, matches } = scanAndRedact(shortToken);
    expect(text).toBe(shortToken);
    expect(matches).toHaveLength(0);
  });
});

describe("credential-scanner: OpenAI / API keys", () => {
  it("redacts sk- key", () => {
    const token = "sk-" + "E".repeat(24);
    const input = `api_key = ${token}`;
    const { text, matches } = scanAndRedact(input);
    expect(text).not.toContain(token);
    expect(text).toContain("[REDACTED:SH-12:OPENAI_SK]");
    expect(matches[0].typeHint).toBe("OPENAI_SK");
  });
});

describe("credential-scanner: AWS keys", () => {
  it("redacts AKIA access key", () => {
    const token = "AKIA" + "F".repeat(16);
    const { text, matches } = scanAndRedact(`AWS_ACCESS_KEY=${token}`);
    expect(text).not.toContain(token);
    expect(text).toContain("[REDACTED:SH-12:AWS_ACCESS_KEY]");
    expect(matches[0].typeHint).toBe("AWS_ACCESS_KEY");
    expect(matches[0].inputLength).toBe(20);
  });

  it("redacts ASIA temporary credential", () => {
    const token = "ASIA" + "G".repeat(16);
    const { text, matches } = scanAndRedact(token);
    expect(text).toBe("[REDACTED:SH-12:AWS_TEMP_CRED]");
    expect(matches[0].typeHint).toBe("AWS_TEMP_CRED");
  });
});

describe("credential-scanner: Slack tokens", () => {
  it("redacts xoxb- bot token", () => {
    const token = "xoxb-" + "1234567890" + "-" + "H".repeat(30);
    const { text, matches } = scanAndRedact(`SLACK_TOKEN=${token}`);
    expect(text).not.toContain(token);
    expect(text).toContain("[REDACTED:SH-12:SLACK_BOT_TOKEN]");
    expect(matches[0].typeHint).toBe("SLACK_BOT_TOKEN");
  });

  it("redacts xoxp- user token", () => {
    const token = "xoxp-" + "I".repeat(20);
    const { text } = scanAndRedact(token);
    expect(text).toBe("[REDACTED:SH-12:SLACK_USER_TOKEN]");
  });
});

describe("credential-scanner: Stripe live keys", () => {
  it("redacts sk_live_ secret key", () => {
    const token = "sk_live_" + "J".repeat(24);
    const { text, matches } = scanAndRedact(`STRIPE_SK=${token}`);
    expect(text).not.toContain(token);
    expect(text).toContain("[REDACTED:SH-12:STRIPE_LIVE_KEY]");
    expect(matches[0].typeHint).toBe("STRIPE_LIVE_KEY");
  });

  it("redacts pk_live_ publishable key", () => {
    const token = "pk_live_" + "K".repeat(24);
    const { text } = scanAndRedact(token);
    expect(text).toBe("[REDACTED:SH-12:STRIPE_LIVE_KEY]");
  });

  it("redacts rk_live_ restricted key", () => {
    const token = "rk_live_" + "L".repeat(24);
    const { text } = scanAndRedact(token);
    expect(text).toBe("[REDACTED:SH-12:STRIPE_LIVE_KEY]");
  });
});

describe("credential-scanner: Google OAuth / npm", () => {
  it("redacts ya29. Google OAuth token", () => {
    const token = "ya29." + "M".repeat(24);
    const { text, matches } = scanAndRedact(token);
    expect(text).toBe("[REDACTED:SH-12:GOOGLE_OAUTH]");
    expect(matches[0].typeHint).toBe("GOOGLE_OAUTH");
  });

  it("redacts npm_ token", () => {
    const token = "npm_" + "N".repeat(36);
    const { text, matches } = scanAndRedact(`//registry.npmjs.org/:_authToken=${token}`);
    expect(text).not.toContain(token);
    expect(text).toContain("[REDACTED:SH-12:NPM_TOKEN]");
    expect(matches[0].typeHint).toBe("NPM_TOKEN");
  });
});

describe("credential-scanner: Bearer / JWT tokens", () => {
  it("redacts Authorization: Bearer header value", () => {
    const tokenValue = "O".repeat(40);
    const input = `Authorization: Bearer ${tokenValue}`;
    const { text, matches } = scanAndRedact(input);
    expect(text).not.toContain(tokenValue);
    expect(text).toContain("[REDACTED:SH-12:BEARER_TOKEN]");
    expect(text).toContain("Authorization:");
    expect(matches[0].typeHint).toBe("BEARER_TOKEN");
  });

  it("redacts JWT-shaped token (eyJ header)", () => {
    const header = "eyJhbGciOiJIUzI1NiJ9";
    const payload = "eyJzdWIiOiJzeW50aGV0aWMtdXNlci1pZCJ9";
    const sig = "P".repeat(43);
    const jwt = `${header}.${payload}.${sig}`;
    const input = `token: ${jwt} end`;
    const { text, matches } = scanAndRedact(input);
    expect(text).not.toContain(jwt);
    expect(text).toContain("[REDACTED:SH-12:JWT_TOKEN]");
    expect(text).toContain("token:");
    expect(text).toContain("end");
    expect(matches[0].typeHint).toBe("JWT_TOKEN");
  });
});

describe("credential-scanner: safe text not redacted", () => {
  it("does not redact plain prose", () => {
    const safe = "This is a normal message about fixing a bug in the auth module.";
    const { text, matches } = scanAndRedact(safe);
    expect(text).toBe(safe);
    expect(matches).toHaveLength(0);
  });

  it("does not redact short strings that look like partial tokens", () => {
    const partials = ["ghp_short", "sk-", "AKIA123", "Bearer x"];
    for (const p of partials) {
      const { matches } = scanAndRedact(p);
      expect(matches, `expected no match for: ${p}`).toHaveLength(0);
    }
  });

  it("returns empty text unchanged", () => {
    const { text, matches } = scanAndRedact("");
    expect(text).toBe("");
    expect(matches).toHaveLength(0);
  });
});

describe("credential-scanner: multi-token and surrounding-text preservation", () => {
  it("redacts multiple tokens in one string", () => {
    const gh = "ghp_" + "Q".repeat(36);
    const aws = "AKIA" + "R".repeat(16);
    const input = `github=${gh} aws=${aws} done`;
    const { text, matches } = scanAndRedact(input);
    expect(text).not.toContain(gh);
    expect(text).not.toContain(aws);
    expect(text).toContain("github=");
    expect(text).toContain("aws=");
    expect(text).toContain("done");
    expect(matches).toHaveLength(2);
  });

  it("characterOffset in match reflects position in original string", () => {
    const prefix = "prefix:";
    const token = "ghp_" + "S".repeat(36);
    const input = prefix + token;
    const { matches } = scanAndRedact(input);
    expect(matches[0].characterOffset).toBe(prefix.length);
    expect(matches[0].inputLength).toBe(token.length);
  });

  it("match record never contains the credential value", () => {
    const token = "sk-" + "T".repeat(24);
    const { matches } = scanAndRedact(token);
    expect(matches).toHaveLength(1);
    // ScanMatch only has typeHint, characterOffset, inputLength
    const keys = Object.keys(matches[0]);
    expect(keys).toEqual(expect.arrayContaining(["typeHint", "characterOffset", "inputLength"]));
    expect(keys).not.toContain("value");
    expect(keys).not.toContain("match");
    expect(keys).not.toContain("raw");
  });
});

describe("credential-scanner: env-driven extra rules (SH12_EXTRA_RULES)", () => {
  it("applies extra rules from SH12_EXTRA_RULES env var", () => {
    const extraRule = JSON.stringify([
      {
        kind: "prefix",
        prefix: "XTEST_",
        typeHint: "CUSTOM_TEST_TOKEN",
        suffixPattern: "[A-Z]{10,}",
      },
    ]);
    const original = process.env["SH12_EXTRA_RULES"];
    process.env["SH12_EXTRA_RULES"] = extraRule;
    resetScannerRuleCache();
    try {
      const token = "XTEST_" + "U".repeat(12);
      const { text, matches } = scanAndRedact(token);
      expect(text).toBe("[REDACTED:SH-12:CUSTOM_TEST_TOKEN]");
      expect(matches[0].typeHint).toBe("CUSTOM_TEST_TOKEN");
    } finally {
      if (original === undefined) {
        delete process.env["SH12_EXTRA_RULES"];
      } else {
        process.env["SH12_EXTRA_RULES"] = original;
      }
      resetScannerRuleCache();
    }
  });

  // P1 regression: invalid regex in SH12_EXTRA_RULES must not break the scanner
  it("skips invalid-regex extra rule and continues scanning with remaining rules", () => {
    const badExtra = JSON.stringify([
      { kind: "regex", typeHint: "BAD_RULE", pattern: "[invalid(regex" },
    ]);
    const original = process.env["SH12_EXTRA_RULES"];
    process.env["SH12_EXTRA_RULES"] = badExtra;
    resetScannerRuleCache();
    try {
      const token = "ghp_" + "V".repeat(36);
      // Must not throw; base rules still fire
      const { text, matches } = scanAndRedact(token);
      expect(text).toContain("[REDACTED:SH-12:GH_PAT]");
      expect(matches[0].typeHint).toBe("GH_PAT");
    } finally {
      if (original === undefined) {
        delete process.env["SH12_EXTRA_RULES"];
      } else {
        process.env["SH12_EXTRA_RULES"] = original;
      }
      resetScannerRuleCache();
    }
  });
});

describe("credential-scanner: characterOffset accuracy across multiple rules", () => {
  // P2 regression: characterOffset must reflect the original input position even
  // when a prior rule has already mutated the text (replacement length ≠ match length)
  it("reports correct characterOffset for second-rule match after first rule fires", () => {
    const gh = "ghp_" + "W".repeat(36);   // 40 chars, matched by GH_PAT rule
    const aws = "AKIA" + "X".repeat(16);  // 20 chars, matched by AWS_ACCESS_KEY rule
    const sep = " | ";
    const input = gh + sep + aws;
    const ghOffset = 0;
    const awsOffset = gh.length + sep.length;
    const { matches } = scanAndRedact(input);
    expect(matches).toHaveLength(2);
    const ghMatch = matches.find((m) => m.typeHint === "GH_PAT");
    const awsMatch = matches.find((m) => m.typeHint === "AWS_ACCESS_KEY");
    expect(ghMatch?.characterOffset).toBe(ghOffset);
    expect(awsMatch?.characterOffset).toBe(awsOffset);
  });

  // P2 regression: within a single rule, second match offset must also be original-relative
  it("reports correct characterOffset for second match within same rule", () => {
    const token = "ghp_" + "Y".repeat(36);  // 40 chars
    const sep = " middle ";
    const input = token + sep + token;
    const firstOffset = 0;
    const secondOffset = token.length + sep.length;
    const { matches } = scanAndRedact(input);
    const ghMatches = matches.filter((m) => m.typeHint === "GH_PAT");
    expect(ghMatches).toHaveLength(2);
    expect(ghMatches[0].characterOffset).toBe(firstOffset);
    expect(ghMatches[1].characterOffset).toBe(secondOffset);
  });
});
