import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  buildSecretAssignmentRegex,
  createLineRedactor,
  createSecretRedactionTransform,
  redactSecretAssignments,
  REDACTED_SECRET_ENV_VARS,
  SECRET_REDACTION_PLACEHOLDER,
} from "./backup-redaction.js";

const SECRET_64 = "a".repeat(40) + "B3+/=_-Zz09aaaaaaaaaaaa"; // 64-ish mixed-alphabet token
const LEAK_REGEX = /PAPERCLIP_AGENT_JWT_SECRET=[A-Za-z0-9+/=_-]{8,}/;
const AUTH_LEAK_REGEX = /BETTER_AUTH_SECRET=[A-Za-z0-9+/=_-]{8,}/;

async function runTransform(chunks: Array<Buffer | string>): Promise<string> {
  const out: Buffer[] = [];
  const source = Readable.from(chunks.map((c) => (typeof c === "string" ? Buffer.from(c) : c)));
  const transform = createSecretRedactionTransform();
  transform.on("data", (chunk: Buffer) => out.push(Buffer.from(chunk)));
  await pipeline(source, transform);
  return Buffer.concat(out).toString("utf8");
}

describe("redactSecretAssignments", () => {
  it("redacts a secret assignment embedded in a COPY data line", () => {
    const line = `12\tsome text PAPERCLIP_AGENT_JWT_SECRET=${SECRET_64} trailing\tcol3`;
    const out = redactSecretAssignments(line);
    expect(out).not.toMatch(LEAK_REGEX);
    expect(out).toContain(`PAPERCLIP_AGENT_JWT_SECRET=${SECRET_REDACTION_PLACEHOLDER}`);
    // surrounding columns/content preserved
    expect(out.startsWith("12\tsome text ")).toBe(true);
    expect(out).toContain(" trailing\tcol3");
  });

  it("redacts every known secret env var", () => {
    const line = `PAPERCLIP_AGENT_JWT_SECRET=${SECRET_64} BETTER_AUTH_SECRET=${SECRET_64}`;
    const out = redactSecretAssignments(line);
    expect(out).not.toMatch(LEAK_REGEX);
    expect(out).not.toMatch(AUTH_LEAK_REGEX);
  });

  it("is idempotent", () => {
    const once = redactSecretAssignments(`PAPERCLIP_AGENT_JWT_SECRET=${SECRET_64}`);
    const twice = redactSecretAssignments(once);
    expect(twice).toBe(once);
    expect(once).toBe(`PAPERCLIP_AGENT_JWT_SECRET=${SECRET_REDACTION_PLACEHOLDER}`);
  });

  it("leaves non-secret assignments and DDL untouched", () => {
    const ddl = `CREATE TABLE "runs" ("id" uuid, "env" text); SOME_OTHER_VAR=${SECRET_64}`;
    expect(redactSecretAssignments(ddl)).toBe(ddl);
  });

  it("does not let redaction cross a newline boundary", () => {
    const text = `PAPERCLIP_AGENT_JWT_SECRET=${SECRET_64}\nkeep=this-line`;
    const out = redactSecretAssignments(text);
    expect(out).toBe(`PAPERCLIP_AGENT_JWT_SECRET=${SECRET_REDACTION_PLACEHOLDER}\nkeep=this-line`);
  });
});

describe("createSecretRedactionTransform", () => {
  it("redacts secrets in a single-chunk stream", async () => {
    const input = `row1\tPAPERCLIP_AGENT_JWT_SECRET=${SECRET_64}\nrow2\tclean\n`;
    const out = await runTransform([input]);
    expect(out).not.toMatch(LEAK_REGEX);
    expect(out).toContain("row2\tclean");
  });

  it("redacts a secret value split across chunk boundaries", async () => {
    // The line is delivered in two chunks that split the secret value itself.
    const head = `data\tPAPERCLIP_AGENT_JWT_SECRET=${SECRET_64.slice(0, 20)}`;
    const tail = `${SECRET_64.slice(20)}\ttrailing\n`;
    const out = await runTransform([head, tail]);
    expect(out).not.toMatch(LEAK_REGEX);
    expect(out).toContain(`PAPERCLIP_AGENT_JWT_SECRET=${SECRET_REDACTION_PLACEHOLDER}`);
    expect(out).toContain("trailing");
  });

  it("preserves byte-for-byte content when there are no secrets", async () => {
    const input = "line-a\nline-b\nno trailing newline";
    const out = await runTransform(["line-a\n", "line-b\nno tra", "iling newline"]);
    expect(out).toBe(input);
  });

  it("flushes a final line that has no trailing newline", async () => {
    const out = await runTransform([`tail\tPAPERCLIP_AGENT_JWT_SECRET=${SECRET_64}`]);
    expect(out).not.toMatch(LEAK_REGEX);
    expect(out.startsWith("tail\t")).toBe(true);
  });
});

describe("createLineRedactor", () => {
  it("holds a partial line as carry and redacts once completed", () => {
    const r = createLineRedactor();
    const first = r.push(`x\tPAPERCLIP_AGENT_JWT_SECRET=${SECRET_64.slice(0, 10)}`);
    expect(first).toBe(""); // no newline yet -> nothing emitted
    const second = r.push(`${SECRET_64.slice(10)}\n`);
    expect(second).not.toMatch(LEAK_REGEX);
    expect(second).toContain(`PAPERCLIP_AGENT_JWT_SECRET=${SECRET_REDACTION_PLACEHOLDER}`);
    expect(r.flush()).toBe("");
  });
});

describe("injectable secret list", () => {
  const CUSTOM_LEAK = /MY_OPERATOR_SECRET=[A-Za-z0-9+/=_-]{8,}/;

  it("redacts an operator-supplied var and passes through the defaults when they are not in the injected list", () => {
    const line = `MY_OPERATOR_SECRET=${SECRET_64} PAPERCLIP_AGENT_JWT_SECRET=${SECRET_64}`;
    const out = redactSecretAssignments(line, ["MY_OPERATOR_SECRET"]);
    // the injected var is redacted...
    expect(out).not.toMatch(CUSTOM_LEAK);
    expect(out).toContain(`MY_OPERATOR_SECRET=${SECRET_REDACTION_PLACEHOLDER}`);
    // ...and the default var is untouched, proving injection replaces the list
    // rather than appending to it (operators extend by including the defaults).
    expect(out).toMatch(LEAK_REGEX);
  });

  it("streams redaction with an injected list end-to-end", async () => {
    const out: Buffer[] = [];
    const source = Readable.from([Buffer.from(`a\tMY_OPERATOR_SECRET=${SECRET_64}\n`)]);
    const transform = createSecretRedactionTransform(["MY_OPERATOR_SECRET"]);
    transform.on("data", (chunk: Buffer) => out.push(Buffer.from(chunk)));
    await pipeline(source, transform);
    expect(Buffer.concat(out).toString("utf8")).not.toMatch(CUSTOM_LEAK);
  });

  it("supports the default plus an operator var when the caller unions them", () => {
    const list = [...REDACTED_SECRET_ENV_VARS, "MY_OPERATOR_SECRET"];
    const line = `MY_OPERATOR_SECRET=${SECRET_64} BETTER_AUTH_SECRET=${SECRET_64}`;
    const out = redactSecretAssignments(line, list);
    expect(out).not.toMatch(CUSTOM_LEAK);
    expect(out).not.toMatch(AUTH_LEAK_REGEX);
  });

  it("throws rather than compiling a match-nothing regex for an empty list", () => {
    expect(() => buildSecretAssignmentRegex([])).toThrow();
  });
});

describe("value grammar hardening", () => {
  it("redacts the whole value even when it contains punctuation outside a token alphabet", () => {
    // A secret value with '.', '!' and other punctuation must not leave a suffix.
    const line = `PAPERCLIP_AGENT_JWT_SECRET=abc.def!ghi$%^&*()-_=+`;
    const out = redactSecretAssignments(line);
    expect(out).toBe(`PAPERCLIP_AGENT_JWT_SECRET=${SECRET_REDACTION_PLACEHOLDER}`);
    expect(out).not.toContain("abc");
    expect(out).not.toContain("def");
    expect(out).not.toContain("ghi");
  });

  it("stops the value at whitespace so it never swallows the next COPY column", () => {
    const line = `12\tPAPERCLIP_AGENT_JWT_SECRET=abc.def\tcol3`;
    const out = redactSecretAssignments(line);
    expect(out).toBe(`12\tPAPERCLIP_AGENT_JWT_SECRET=${SECRET_REDACTION_PLACEHOLDER}\tcol3`);
  });

  it("stops the value at a quote so it never swallows the next quoted field", () => {
    const line = `["PAPERCLIP_AGENT_JWT_SECRET=abc.def","OTHER=keepme"]`;
    const out = redactSecretAssignments(line);
    expect(out).toContain(`PAPERCLIP_AGENT_JWT_SECRET=${SECRET_REDACTION_PLACEHOLDER}`);
    expect(out).toContain(`"OTHER=keepme"`);
    expect(out).not.toContain("abc.def");
  });

  it("does not match on an embedded name (left boundary), leaving unrelated variables intact", () => {
    const line = `NOT_PAPERCLIP_AGENT_JWT_SECRET=value123 X_BETTER_AUTH_SECRET=value456`;
    const out = redactSecretAssignments(line);
    expect(out).toBe(line); // neither is one of our variables
  });

  it("still matches the real variable at a start or after a non-name character", () => {
    expect(redactSecretAssignments(`PAPERCLIP_AGENT_JWT_SECRET=abc.def`)).toBe(
      `PAPERCLIP_AGENT_JWT_SECRET=${SECRET_REDACTION_PLACEHOLDER}`,
    );
    expect(redactSecretAssignments(`env: PAPERCLIP_AGENT_JWT_SECRET=abc.def`)).toBe(
      `env: PAPERCLIP_AGENT_JWT_SECRET=${SECRET_REDACTION_PLACEHOLDER}`,
    );
  });

  it("is idempotent under the punctuation grammar", () => {
    const once = redactSecretAssignments(`PAPERCLIP_AGENT_JWT_SECRET=abc.def!ghi`);
    const twice = redactSecretAssignments(once);
    expect(twice).toBe(once);
  });
});

describe("bounded buffering on a very long unbroken line", () => {
  it("force-flushes a redacted prefix and never bisects a secret near the tail", () => {
    const r = createLineRedactor();
    // One physical line, no newline, > 1 MiB: a secret at the start, ~1.2 MiB of
    // space-delimited filler, then a second secret in the final bytes (the tail).
    const filler = "x ".repeat(650_000); // ~1.3 MiB, whitespace boundaries throughout
    const line =
      `PAPERCLIP_AGENT_JWT_SECRET=earlysecret.value ${filler} PAPERCLIP_AGENT_JWT_SECRET=latesecret.value`;
    const emitted = r.push(line);
    // The bound engaged: a redacted prefix was emitted rather than buffering it all.
    expect(emitted.length).toBeGreaterThan(0);
    const tail = r.flush();
    const combined = emitted + tail;
    // Neither secret survived, and neither was half-redacted (no fragment left).
    expect(combined).not.toContain("earlysecret");
    expect(combined).not.toContain("latesecret");
    expect(combined).not.toContain("earlysecret.value");
    expect(combined).not.toContain("latesecret.value");
    expect(combined).toContain(`PAPERCLIP_AGENT_JWT_SECRET=${SECRET_REDACTION_PLACEHOLDER}`);
  });
});
