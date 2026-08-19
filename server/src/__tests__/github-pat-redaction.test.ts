import { describe, expect, it } from "vitest";
import { REDACTED_EVENT_VALUE, redactSensitiveText } from "../redaction.js";
import {
  MIN_REDACTABLE_SECRET_LENGTH,
  collectRunSecretValues,
  createSecretValueRedactor,
  orderRedactableSecretValues,
} from "../secret-value-redaction.js";

// Synthetic value only. Shaped like a fine-grained GitHub PAT (github_pat_ + 22 chars
// + "_" + 59 chars) but built from a fixed filler alphabet so it can never be a real
// credential.
const SYNTHETIC_FINE_GRAINED_PAT = `github_pat_${"A".repeat(22)}_${"b".repeat(59)}`;
const SYNTHETIC_CLASSIC_PAT = `ghp_${"C".repeat(36)}`;

describe("fine-grained GitHub PAT redaction", () => {
  it("redacts a bare token in prose", () => {
    const out = redactSensitiveText(`Token: ${SYNTHETIC_FINE_GRAINED_PAT} was used to push`);

    expect(out).not.toContain(SYNTHETIC_FINE_GRAINED_PAT);
    expect(out).toBe(`Token: ${REDACTED_EVENT_VALUE} was used to push`);
  });

  it("redacts a token embedded in a remote URL", () => {
    const out = redactSensitiveText(
      `git remote add origin https://${SYNTHETIC_FINE_GRAINED_PAT}@github.com/acme/are-scanner.git`,
    );

    expect(out).not.toContain(SYNTHETIC_FINE_GRAINED_PAT);
    expect(out).toContain("@github.com/acme/are-scanner.git");
  });

  it("redacts a token in a NAME=value assignment whose name has no secret word", () => {
    // GITHUB_PAT_ARE_SCANNER carries no token/key/secret/credential substring, so the
    // name-driven rule never fired for it before this fix.
    const out = redactSensitiveText(`GITHUB_PAT_ARE_SCANNER=${SYNTHETIC_FINE_GRAINED_PAT}`);

    expect(out).not.toContain(SYNTHETIC_FINE_GRAINED_PAT);
    expect(out).toBe(`GITHUB_PAT_ARE_SCANNER=${REDACTED_EVENT_VALUE}`);
  });

  it("redacts a token inside a JSON string field", () => {
    const out = redactSensitiveText(
      JSON.stringify({ oauth_token: SYNTHETIC_FINE_GRAINED_PAT, repo: "acme/are-scanner" }),
    );

    expect(out).not.toContain(SYNTHETIC_FINE_GRAINED_PAT);
    expect(out).toContain('"repo":"acme/are-scanner"');
  });

  it("redacts a token preceded by a word character", () => {
    // NDJSON run logs store a newline as the two characters \\ and n, so a token at the
    // start of a captured line is immediately preceded by `n`. A leading \\b never fired
    // there and 4 real corpus lines survived the first version of this fix because of it.
    const out = redactSensitiveText(`prior line\\n${SYNTHETIC_FINE_GRAINED_PAT}\\nnext line`);

    expect(out).not.toContain(SYNTHETIC_FINE_GRAINED_PAT);
    expect(out).toBe(`prior line\\n${REDACTED_EVENT_VALUE}\\nnext line`);
  });

  it("redacts a classic token preceded by a word character", () => {
    expect(redactSensitiveText(`len=93${SYNTHETIC_CLASSIC_PAT} end`)).not.toContain(
      SYNTHETIC_CLASSIC_PAT,
    );
  });

  it("still redacts classic tokens", () => {
    expect(redactSensitiveText(`using ${SYNTHETIC_CLASSIC_PAT} now`)).not.toContain(
      SYNTHETIC_CLASSIC_PAT,
    );
  });

  it("leaves ordinary github prose alone", () => {
    const input = "cloned https://github.com/acme/are-scanner.git at commit abc1234";

    expect(redactSensitiveText(input)).toBe(input);
  });

  it("does not treat PATH as a credential name", () => {
    const input = "PATH=/usr/local/bin:/usr/bin";

    expect(redactSensitiveText(input)).toBe(input);
  });
});

describe("secret value redaction by identity", () => {
  it("redacts a bound secret value that matches no known credential shape", () => {
    const redact = createSecretValueRedactor(["vendor-prefix-nobody-taught-the-regex-yet"]);

    expect(redact("exported vendor-prefix-nobody-taught-the-regex-yet to the sandbox")).toBe(
      `exported ${REDACTED_EVENT_VALUE} to the sandbox`,
    );
  });

  it("redacts every occurrence in a chunk", () => {
    const redact = createSecretValueRedactor(["super-secret-value-1234"]);

    const out = redact("a super-secret-value-1234 b super-secret-value-1234 c");

    expect(out).not.toContain("super-secret-value-1234");
    expect(out.split(REDACTED_EVENT_VALUE)).toHaveLength(3);
  });

  it("skips values shorter than the minimum so short env values cannot blank output", () => {
    const short = "a".repeat(MIN_REDACTABLE_SECRET_LENGTH - 1);

    expect(createSecretValueRedactor([short])(`value ${short} here`)).toBe(`value ${short} here`);
    expect(orderRedactableSecretValues([short, "true", "1"])).toEqual([]);
  });

  it("orders values longest-first so overlapping secrets redact cleanly", () => {
    const inner = "overlapping-secret";
    const outer = `${inner}-with-suffix`;

    expect(orderRedactableSecretValues([inner, outer])).toEqual([outer, inner]);
    expect(createSecretValueRedactor([inner, outer])(`x ${outer} y`)).toBe(
      `x ${REDACTED_EVENT_VALUE} y`,
    );
  });

  it("collects secret-ref-bound values and credential-named values, and skips the rest", () => {
    const env = {
      GITHUB_PAT_ARE_SCANNER: SYNTHETIC_FINE_GRAINED_PAT,
      SOME_OPAQUE_BINDING: "resolved-from-a-secret-ref",
      PATH: "/usr/local/bin:/usr/bin",
      PAPERCLIP_API_URL: "http://127.0.0.1:3100",
      PORT: 3100,
    };

    const values = collectRunSecretValues(env, ["SOME_OPAQUE_BINDING"]);

    expect(values).toEqual([SYNTHETIC_FINE_GRAINED_PAT, "resolved-from-a-secret-ref"]);
    expect(values).not.toContain("/usr/local/bin:/usr/bin");
    expect(values).not.toContain("http://127.0.0.1:3100");
  });

  it("is a no-op when the run bound nothing redactable", () => {
    const redact = createSecretValueRedactor([]);
    const input = "nothing to redact here";

    expect(redact(input)).toBe(input);
  });
});
