import { describe, expect, it } from "vitest";
import {
  collectKnownSecretEnvValues,
  createSecretEnvRedactionStream,
  createSecretEnvRedactionScanner,
  KNOWN_SECRET_ENV_VAR_NAMES,
  redactKnownSecretEnvValues,
} from "./secret-env-redaction.js";

describe("collectKnownSecretEnvValues", () => {
  it("collects values for known secret env names only", () => {
    const values = collectKnownSecretEnvValues({
      DATABASE_URL: "postgres://user:pass@host:5432/db",
      PATH: "/usr/bin",
      ANTHROPIC_API_KEY: "sk-ant-abcdefghijklmnop",
    });
    expect(values).toContain("postgres://user:pass@host:5432/db");
    expect(values).toContain("sk-ant-abcdefghijklmnop");
    expect(values).not.toContain("/usr/bin");
  });

  it("drops values shorter than the minimum redactable length", () => {
    const values = collectKnownSecretEnvValues({ DATABASE_URL: "x" });
    expect(values).toHaveLength(0);
  });

  it("supports extending the denylist by name, not by learning from values", () => {
    const values = collectKnownSecretEnvValues(
      { CUSTOM_TENANT_SECRET: "some-extended-secret-value" },
      ["CUSTOM_TENANT_SECRET"],
    );
    expect(values).toContain("some-extended-secret-value");
  });

  it("includes the seed names from the originating scan", () => {
    for (const name of [
      "PAPERCLIP_TOOL_ACTION_SIGNING_SECRET",
      "DATABASE_URL",
      "ANTHROPIC_API_KEY",
      "BETTER_AUTH_SECRET",
    ]) {
      expect(KNOWN_SECRET_ENV_VAR_NAMES).toContain(name);
    }
  });
});

describe("redactKnownSecretEnvValues", () => {
  it("replaces every occurrence of a known secret value", () => {
    const out = redactKnownSecretEnvValues(
      "DATABASE_URL=leaked-secret-value\nagain: leaked-secret-value",
      ["leaked-secret-value"],
    );
    expect(out).not.toContain("leaked-secret-value");
    expect(out.match(/\*\*\*REDACTED\*\*\*/g)?.length).toBe(2);
  });

  it("prefers the longer match when one secret value is a substring of another", () => {
    const out = redactKnownSecretEnvValues("prefix-secret-suffix-tail", [
      "prefix-secret-suffix-tail",
      "secret-suffix",
    ]);
    expect(out).toBe("***REDACTED***");
  });

  it("redacts overlapping occurrences as one range", () => {
    expect(redactKnownSecretEnvValues("BBBBB", ["BBBB"])).toBe(
      "***REDACTED***",
    );
  });

  it("is a no-op when there is nothing to redact", () => {
    expect(redactKnownSecretEnvValues("hello world", [])).toBe("hello world");
    expect(redactKnownSecretEnvValues("", ["x-secret-value"])).toBe("");
  });
});

describe("createSecretEnvRedactionScanner", () => {
  it.each(["123456", "-123456", "1.123456", "1e123456", "123456789"])(
    "replaces a matching numeric token with a neutral JSON number: %s",
    (number) => {
      const scan = createSecretEnvRedactionScanner(["123456"], 65536);
      scan.append(`{"type":"result","metric":${number},"safe":17}`);
      expect(JSON.parse(scan.snapshot())).toEqual({ type: "result", metric: 0, safe: 17 });
      expect(scan.snapshot()).not.toContain("123456");
    },
  );

  it("sanitizes strings and keys without treating their digits as numbers", () => {
    const scan = createSecretEnvRedactionScanner(["123456", 'quoted"secret'], 65536);
    scan.append(JSON.stringify({ "123456": "prefix-123456-suffix", unmatched: 'quoted"secret' }));
    expect(JSON.parse(scan.snapshot())).toEqual({
      "***REDACTED***": "***REDACTED***", unmatched: 'quoted"secret',
    });
  });

  it("does not turn a matched JSON record or malformed record into a result", () => {
    const scan = createSecretEnvRedactionScanner(['{"type":"result"}', "123456"], 65536);
    scan.append('{"type":"result"}\n{"type":"result","metric":0123456}\n');
    expect(scan.snapshot()).toBe("***REDACTED***\n***REDACTED***\n");
  });

  it("retains recognized coverage through clipping, empty rescans and later appends", () => {
    const secret = 'prefix\n{"type":"result"}\nsuffix';
    const scan = createSecretEnvRedactionScanner([secret], 64);
    const seen: string[] = [];
    scan.append(secret, (text) => seen.push(text));
    scan.append("x".repeat(64 - (secret.length - "prefix\n".length)), (text) => seen.push(text));
    seen.push(scan.snapshot());
    scan.append("", (text) => seen.push(text));
    scan.append("more-safe-data\n", (text) => seen.push(text));
    seen.push(scan.snapshot());
    expect(seen.every((text) => !text.includes('{"type":"result"}'))).toBe(true);
    expect(scan.snapshot()).toContain("more-safe-data");
  });

  it("preserves overlapping coverage across every split and window translation", () => {
    const secret = "ABABAB";
    for (const cap of [8, 32]) {
      for (let split = 0; split <= 12; split += 1) {
        const scan = createSecretEnvRedactionScanner([secret], cap);
        scan.append("ABABABABABAB".slice(0, split));
        scan.append("ABABABABABAB".slice(split));
        // Intact records retain merged coverage; clipped records are suppressed.
        expect(scan.snapshot()).toBe(cap === 8 ? "" : "***REDACTED***");
        scan.append(" safe");
        expect(scan.snapshot()).toBe(cap === 8 ? "" : "***REDACTED*** safe");
      }
    }
  });

  it("never promotes a clipped leading fragment during rescans or later appends", () => {
    const record = '{"type":"result"}';
    const scan = createSecretEnvRedactionScanner([], record.length);
    const seen: string[] = [];
    scan.append("x" + record, (text) => seen.push(text));
    expect(seen).toEqual(["x" + record]);
    expect(scan.snapshot()).toBe("");
    scan.append("", (text) => seen.push(text));
    expect(seen.at(-1)).toBe("");
    scan.append("\n" + record, (text) => seen.push(text));
    expect(seen.at(-1)).toBe("\n" + record);
    expect(scan.snapshot()).toBe(record);
  });

  it.each(["stdout:", "STDERR = ", "stdout ", "  StDeRr:"])(
    "sanitizes the original Cursor payload behind %s framing", (prefix) => {
      const scan = createSecretEnvRedactionScanner(["123456"], 1024);
      const payload = '{"type":"result","result":"completed","usage":{"input_tokens":123456,"output_tokens":7}}';
      scan.append(prefix + payload + "  ");
      expect(scan.snapshot()).toBe(prefix + payload.replace("123456", "0") + "  ");
    },
  );

  it.each(["stdout:", "STDERR = ", "stdout ", "  StDeRr:"])(
    "does not repair a malformed Cursor payload behind %s framing", (prefix) => {
      const scan = createSecretEnvRedactionScanner(['BAD"DATA'], 1024);
      scan.append(prefix + '{"type":"result","result":"BAD"DATA"}');
      expect(scan.snapshot()).toBe("***REDACTED***");
    },
  );

  it.each(["stdout", "stdout:{", "      "])(
    "suppresses protected Cursor framing or whitespace %j", (secret) => {
      const scan = createSecretEnvRedactionScanner([secret], 1024);
      scan.append('      stdout:{"type":"result","result":"completed"}');
      expect(scan.snapshot()).toBe("***REDACTED***");
    },
  );

  it("inspects complete candidates before retention without waiting for EOF", () => {
    const scan = createSecretEnvRedactionScanner(["123456"], 8);
    let inspected = "";
    scan.append('{"type":"result","metric":123456}', (text) => { inspected = text; });
    expect(JSON.parse(inspected)).toEqual({ type: "result", metric: 0 });
    expect(scan.snapshot()).not.toContain("123456");
  });
});

describe("createSecretEnvRedactionStream", () => {
  const SECRET = "postgres://user:p4ssw0rd@db.internal:5432/paperclip";

  it("redacts a secret split across two chunks", () => {
    const stream = createSecretEnvRedactionStream([SECRET]);
    const split = 20;
    const out =
      stream.push("head " + SECRET.slice(0, split)) +
      stream.push(SECRET.slice(split) + " tail") +
      stream.flush();
    expect(out).not.toContain(SECRET);
    expect(out).toBe("head ***REDACTED*** tail");
  });

  it("redacts a secret split one character at a time", () => {
    const stream = createSecretEnvRedactionStream([SECRET]);
    let out = "";
    for (const ch of "x" + SECRET + "y") out += stream.push(ch);
    out += stream.flush();
    expect(out).not.toContain(SECRET);
    expect(out).toBe("x***REDACTED***y");
  });

  it("emits safe progress immediately even when a secret is much longer", () => {
    const stream = createSecretEnvRedactionStream(["Z".repeat(2048)]);
    for (let tick = 0; tick < 24; tick += 1) {
      expect(stream.push("tick\n")).toBe("tick\n");
    }
    expect(stream.flush()).toBe("");
  });

  it("holds only a possible secret prefix and promptly releases a mismatch", () => {
    const stream = createSecretEnvRedactionStream(["ABABAB", "BABABA"]);
    expect(stream.push("progress ABAB")).toBe("progress ");
    expect(stream.push("X\n")).toBe("ABABX\n");
    expect(stream.push("next tick\n")).toBe("next tick\n");
    expect(stream.flush()).toBe("");
  });

  it("does not drop, duplicate or reorder output when nothing matches", () => {
    const stream = createSecretEnvRedactionStream([SECRET]);
    const chunks = ["alpha ", "beta ", "gamma ", "delta"];
    let out = "";
    for (const chunk of chunks) out += stream.push(chunk);
    out += stream.flush();
    expect(out).toBe(chunks.join(""));
  });

  it("does not split a complete match when its suffix is also a secret prefix", () => {
    const stream = createSecretEnvRedactionStream(["abcabc"]);
    const out = stream.push("abcabc") + stream.flush();
    expect(out).toBe("***REDACTED***");
  });

  it("retains a shorter safe suffix when a longer candidate crosses a match", () => {
    const secret = "AAABAAA";
    const stream = createSecretEnvRedactionStream([secret]);
    const out = stream.push("AAABAAAA") + stream.push("AABAAA") + stream.flush();
    expect(out).not.toContain(secret);
    expect(out).toBe("***REDACTED******REDACTED***");
  });

  it("redacts periodic overlapping values across chunks", () => {
    const secret = "ABABAB";
    const stream = createSecretEnvRedactionStream([secret]);
    const out = stream.push("ABABABAB") + stream.push("ABAB") + stream.flush();
    expect(out).not.toContain(secret);
    expect(out).toBe("***REDACTED***");
  });

  it("redacts repeated-character overlaps across chunks", () => {
    const secret = "BBBBBB";
    const stream = createSecretEnvRedactionStream([secret]);
    const out = stream.push("BBBBBBB") + stream.push("BBBBB") + stream.flush();
    expect(out).not.toContain(secret);
    expect(out).toBe("***REDACTED***");
  });

  it("merges overlap coverage across every partition of a periodic input", () => {
    for (const [secret, input] of [["ABABAB", "ABABABABABAB"], ["BBBBBB", "BBBBBBBBBBBB"]]) {
      const expected = redactKnownSecretEnvValues(input, [secret]);
      for (let split = 0; split <= input.length; split += 1) {
        const stream = createSecretEnvRedactionStream([secret]);
        const out = stream.push(input.slice(0, split)) + stream.push(input.slice(split)) + stream.flush();
        expect(out).toBe(expected);
        expect(stream.flush()).toBe("");
      }
    }
  });

  it("preserves overlapping coverage shared by different secret values", () => {
    const values = ["ABCDEF", "DEFGHI"];
    const stream = createSecretEnvRedactionStream(values, "[hidden]");
    let out = "";
    for (const char of "head ABCDEFGHI tail") out += stream.push(char);
    expect(out + stream.flush()).toBe("head [hidden] tail");
  });

  it("preserves incomplete prefixes and adjacent non-overlapping matches", () => {
    for (const input of ["ABC", "ABCDEFABCDEF", "plain ABC tail"]) {
      const stream = createSecretEnvRedactionStream(["ABCDEF", ""]);
      let out = "";
      for (const char of input) out += stream.push(char);
      expect(out + stream.flush()).toBe(redactKnownSecretEnvValues(input, ["ABCDEF"]));
    }
  });

  it("passes chunks straight through when there are no secrets", () => {
    const stream = createSecretEnvRedactionStream([]);
    expect(stream.push("anything at all")).toBe("anything at all");
    expect(stream.flush()).toBe("");
  });

  it("holds back no more than the longest secret", () => {
    const stream = createSecretEnvRedactionStream([SECRET]);
    const emitted = stream.push("z".repeat(10_000));
    expect(10_000 - emitted.length).toBeLessThan(SECRET.length);
  });
});
