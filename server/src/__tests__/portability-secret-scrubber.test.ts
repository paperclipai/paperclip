import { describe, expect, it } from "vitest";
import {
  detectSecretsInFiles,
  detectSecretsInManifest,
  formatMatchWarnings,
  listScrubPatterns,
  scrubFiles,
  scrubManifest,
  scrubText,
  summarizeMatches,
} from "../services/portability-secret-scrubber.js";

describe("portability-secret-scrubber", () => {
  describe("scrubText pattern table", () => {
    const cases: Array<[string, string, string]> = [
      [
        "provider_api_key:openai",
        "Here is sk-prod-AbCdEf1234567890XyZqWeRtYuIoP and more text",
        "provider_api_key",
      ],
      [
        "provider_api_key:anthropic",
        "key=sk-ant-AbCdEf1234567890XyZqWeRtYu",
        "provider_api_key",
      ],
      [
        "provider_api_key:stripe_live",
        "stripe sk_live_AbCdEf1234567890Xy in body",
        "provider_api_key",
      ],
      [
        "github_pat:classic",
        "token ghp_AbCdEf1234567890XyZqWeRtYu",
        "github_pat",
      ],
      [
        "github_pat:server_to_server",
        "token ghs_AbCdEf1234567890XyZqWeRtYu",
        "github_pat",
      ],
      [
        "slack_token",
        "use xoxb-1234567890-AbCdEf",
        "slack_token",
      ],
      [
        "jwt",
        "Authorization eyJabcdefgh.eyJ12345678.SignatureXyZ",
        "jwt",
      ],
      [
        "bearer_token",
        "header Authorization: Bearer abcd1234efgh5678ijkl9012mnop",
        "bearer_token",
      ],
      [
        "hex_secret_64:env_assignment",
        "PAPERCLIP_AGENT_JWT_SECRET=55e2c1a3b4d5e6f70819a2b3c4d5e6f70819a2b3c4d5e6f70819a2b3c4d5ddc9",
        "hex_secret_64",
      ],
      [
        "hex_secret_64:json_value",
        '"apiKey": "55e2c1a3b4d5e6f70819a2b3c4d5e6f70819a2b3c4d5e6f70819a2b3c4d5ddc9"',
        "hex_secret_64",
      ],
      [
        "hex_secret_64:yaml_value",
        "signing_key: 55e2c1a3b4d5e6f70819a2b3c4d5e6f70819a2b3c4d5e6f70819a2b3c4d5ddc9",
        "hex_secret_64",
      ],
      [
        "credential_url:postgres",
        "DATABASE_URL=postgres://user:supersecretpass@db.internal:5432/app",
        "credential_url",
      ],
      [
        "credential_url:mongodb_srv",
        "uri mongodb+srv://app:secret@cluster.example.com/db",
        "credential_url",
      ],
      [
        "pem_private_key",
        "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEAfake\nfake==\n-----END RSA PRIVATE KEY-----",
        "pem_private_key",
      ],
    ];
    for (const [name, input, pattern] of cases) {
      it(`detects ${name}`, () => {
        const result = scrubText(input);
        expect(result.counts.get(pattern), `expected ${pattern} match in ${name}`).toBeGreaterThan(0);
        expect(result.text).toContain("<REDACTED:");
      });
    }

    it("returns the original text and empty counts when no patterns match", () => {
      const input = "This is an ordinary issue description with no secrets.";
      const result = scrubText(input);
      expect(result.text).toBe(input);
      expect(result.counts.size).toBe(0);
    });

    it("does not match a 40-char commit SHA as hex_secret_64", () => {
      const input = "fix in commit a1b2c3d4e5f6789012345678901234567890abcd";
      const result = scrubText(input);
      expect(result.counts.has("hex_secret_64")).toBe(false);
    });

    it("does not match mixed-case SHA-256 display strings", () => {
      const input = "SHA256: ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890";
      const result = scrubText(input);
      expect(result.counts.has("hex_secret_64")).toBe(false);
    });

    it("does not match bare lowercase SHA-256 digests as hex_secret_64", () => {
      const input =
        "image hash 55e2c1a3b4d5e6f70819a2b3c4d5e6f70819a2b3c4d5e6f70819a2b3c4d5ddc9 in changelog";
      const result = scrubText(input);
      expect(result.counts.has("hex_secret_64")).toBe(false);
      expect(result.text).toBe(input);
    });

    it("does not match Docker sha256 digest references as hex_secret_64", () => {
      const input =
        "FROM ubuntu@sha256:55e2c1a3b4d5e6f70819a2b3c4d5e6f70819a2b3c4d5e6f70819a2b3c4d5ddc9";
      const result = scrubText(input);
      expect(result.counts.has("hex_secret_64")).toBe(false);
      expect(result.text).toBe(input);
    });

    it("does not match a pinned dependency content hash as hex_secret_64", () => {
      const input =
        "sha256-VkmexkXKAo3CrZmDLfcVO6X+iWwsAlVbm0Hz7vJq+rs=  yarn.lock\n" +
        "55e2c1a3b4d5e6f70819a2b3c4d5e6f70819a2b3c4d5e6f70819a2b3c4d5ddc9  archive.tar.gz";
      const result = scrubText(input);
      expect(result.counts.has("hex_secret_64")).toBe(false);
      expect(result.text).toBe(input);
    });

    it("requires an assignment delimiter — a credential keyword followed by a space is not enough", () => {
      const input =
        "secret 55e2c1a3b4d5e6f70819a2b3c4d5e6f70819a2b3c4d5e6f70819a2b3c4d5ddc9 inline";
      const result = scrubText(input);
      expect(result.counts.has("hex_secret_64")).toBe(false);
    });

    it("redacts only the hex portion of a hex_secret_64 match, preserving the key prefix", () => {
      const hex = "55e2c1a3b4d5e6f70819a2b3c4d5e6f70819a2b3c4d5e6f70819a2b3c4d5ddc9";
      const result = scrubText(`PAPERCLIP_AGENT_JWT_SECRET=${hex}`);
      expect(result.text).toBe("PAPERCLIP_AGENT_JWT_SECRET=<REDACTED:hex_secret_64>");
      expect(result.counts.get("hex_secret_64")).toBe(1);
    });

    it("counts multiple matches in one string", () => {
      const input = "two keys: sk-AAAAAAAAAAAAAAAAAAAAAAAA and sk-BBBBBBBBBBBBBBBBBBBBBBBB";
      const result = scrubText(input);
      expect(result.counts.get("provider_api_key")).toBe(2);
    });
  });

  describe("listScrubPatterns", () => {
    it("ships at least the documented minimum patterns", () => {
      const names = listScrubPatterns().map((p) => p.name);
      for (const required of [
        "provider_api_key",
        "github_pat",
        "slack_token",
        "pem_private_key",
        "jwt",
        "bearer_token",
        "hex_secret_64",
        "credential_url",
      ]) {
        expect(names).toContain(required);
      }
    });

    it("classifies every shipped pattern as high severity for now", () => {
      for (const pattern of listScrubPatterns()) {
        expect(pattern.severity).toBe("high");
      }
    });
  });

  describe("scrubManifest", () => {
    it("walks into nested objects and arrays", () => {
      const manifest = {
        company: { description: "All good" },
        issues: [
          {
            comments: [
              { body: "secret sk-AbCdEf1234567890XyZqWeRtYu was pasted by mistake" },
              { body: "totally clean" },
            ],
          },
        ],
      };
      const result = scrubManifest(manifest);
      expect(result.matches).toHaveLength(1);
      const [match] = result.matches;
      expect(match.patternName).toBe("provider_api_key");
      expect(match.path).toBe("manifest.issues[0].comments[0].body");
      expect(JSON.stringify(result.manifest)).toContain("<REDACTED:provider_api_key>");
      expect(JSON.stringify(result.manifest)).not.toContain("sk-AbCdEf1234567890XyZqWeRtYu");
    });

    it("returns the input shape untouched when no matches are found", () => {
      const manifest = { issues: [{ description: "nothing to see" }] };
      const result = scrubManifest(manifest);
      expect(result.matches).toEqual([]);
      expect(result.manifest).toEqual(manifest);
    });
  });

  describe("scrubFiles", () => {
    it("scrubs string file bodies and passes base64 entries through untouched", () => {
      const files = {
        "tasks/foo/TASK.md": "leaked ghp_AbCdEf1234567890XyZqWeRtYu in body",
        "company/logo.png": { encoding: "base64" as const, data: "Z2hwX0FiQ2RFZjEyMzQ1Njc4OTBYeVpxV2VSdFl1" },
      };
      const result = scrubFiles(files);
      expect(result.matches).toHaveLength(1);
      expect(result.matches[0].patternName).toBe("github_pat");
      expect(result.matches[0].path).toBe('files["tasks/foo/TASK.md"]');
      expect(result.files["tasks/foo/TASK.md"]).toContain("<REDACTED:github_pat>");
      expect(result.files["company/logo.png"]).toEqual(files["company/logo.png"]);
    });
  });

  describe("detectSecretsInManifest", () => {
    it("returns the same match shape as scrubManifest without mutating the input", () => {
      const manifest = {
        issues: [
          {
            comments: [
              { body: "secret sk-AbCdEf1234567890XyZqWeRtYu was pasted by mistake" },
              { body: "totally clean" },
            ],
          },
        ],
      };
      const before = JSON.stringify(manifest);
      const matches = detectSecretsInManifest(manifest);
      expect(JSON.stringify(manifest)).toBe(before);
      expect(matches).toHaveLength(1);
      expect(matches[0].patternName).toBe("provider_api_key");
      expect(matches[0].path).toBe("manifest.issues[0].comments[0].body");
    });

    it("returns an empty match list for a clean manifest", () => {
      const matches = detectSecretsInManifest({ issues: [{ description: "nothing here" }] });
      expect(matches).toEqual([]);
    });
  });

  describe("detectSecretsInFiles", () => {
    it("flags string files and skips base64 entries", () => {
      const files = {
        "tasks/foo/TASK.md": "leaked ghp_AbCdEf1234567890XyZqWeRtYu in body",
        "company/logo.png": { encoding: "base64" as const, data: "Z2hwX0FiQ2RFZjEyMzQ1Njc4OTBYeVpxV2VSdFl1" },
      };
      const matches = detectSecretsInFiles(files);
      expect(matches).toHaveLength(1);
      expect(matches[0].patternName).toBe("github_pat");
      expect(matches[0].path).toBe('files["tasks/foo/TASK.md"]');
    });
  });

  describe("summarizeMatches", () => {
    it("rolls up totals and per-pattern counts", () => {
      const matches = [
        { patternName: "provider_api_key", severity: "high" as const, path: "a", count: 2 },
        { patternName: "jwt", severity: "high" as const, path: "b", count: 1 },
        { patternName: "provider_api_key", severity: "high" as const, path: "c", count: 1 },
      ];
      const summary = summarizeMatches(matches);
      expect(summary.total).toBe(4);
      expect(summary.highSeverity).toBe(4);
      expect(summary.byPattern).toEqual({ provider_api_key: 3, jwt: 1 });
    });
  });

  describe("formatMatchWarnings", () => {
    it("renders one human-readable line per match", () => {
      const warnings = formatMatchWarnings([
        { patternName: "provider_api_key", severity: "high", path: "manifest.x", count: 1 },
        { patternName: "jwt", severity: "high", path: "manifest.y", count: 3 },
      ]);
      expect(warnings).toEqual([
        "Export scrubber: redacted 1 provider_api_key match at manifest.x.",
        "Export scrubber: redacted 3 jwt matches at manifest.y.",
      ]);
    });
  });
});

