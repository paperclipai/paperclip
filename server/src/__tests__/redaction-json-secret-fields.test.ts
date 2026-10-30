import { describe, expect, it } from "vitest";

import { REDACTED_EVENT_VALUE, redactSensitiveText } from "../redaction.js";

describe("redaction keeps JSON escaping intact around redacted secrets", () => {
  it("keeps an apikey inside a JSON string valid when an escaped quote follows", () => {
    const input = JSON.stringify({ v: 'a.js?apikey=SECRET123","bnt_t"' });
    const output = redactSensitiveText(input);
    expect(output).toBe('{"v":"a.js?apikey=***REDACTED***\\",\\"bnt_t\\""}');
    expect(() => JSON.parse(output)).not.toThrow();
    expect(output).not.toContain("SECRET123");
  });

  it("keeps a trailing literal backslash in a redacted JSON string value", () => {
    const input = JSON.stringify({ v: "a.js?apikey=SECRET123\\" });
    const output = redactSensitiveText(input);
    expect(JSON.parse(output)).toEqual({ v: "a.js?apikey=***REDACTED***\\" });
    expect(output).not.toContain("SECRET123");
  });

  it("redacts a JSON secret-field value that contains an escaped quote", () => {
    const output = redactSensitiveText('{"token":"pre\\"MARKERQUOTE_A"}');
    expect(output).toBe(`{"token":"${REDACTED_EVENT_VALUE}"}`);
    expect(() => JSON.parse(output)).not.toThrow();
  });

  it("redacts an escaped-JSON secret-field value that contains an escaped quote", () => {
    const output = redactSensitiveText(JSON.stringify('{"token":"pre\\"MARKERQUOTE_B"}'));
    expect(JSON.parse(output)).toBe(`{"token":"${REDACTED_EVENT_VALUE}"}`);
    expect(output).not.toContain("MARKERQUOTE_B");
  });

  it("keeps redacting an apikey on a second pass", () => {
    const once = redactSensitiveText(JSON.stringify({ v: 'a.js?apikey=SECRET123","bnt_t"' }));
    expect(redactSensitiveText(once)).toBe(once);
  });
});

describe("escaped JSON fields keep neighboring fields", () => {
  it("keeps a neighboring field when redacting multi-field escaped JSON", () => {
    const input = JSON.stringify(
      JSON.stringify({ token: "abc", message: "hello" }),
    );
    const output = redactSensitiveText(input);
    expect(output).toBe(
      JSON.stringify(
        JSON.stringify({ token: REDACTED_EVENT_VALUE, message: "hello" }),
      ),
    );
    expect(JSON.parse(JSON.parse(output))).toEqual({
      token: REDACTED_EVENT_VALUE,
      message: "hello",
    });
  });

  it("redacts an escaped-quote value and keeps its neighbor", () => {
    const input = JSON.stringify(
      JSON.stringify({ token: 'pre"X', message: "hello" }),
    );
    const output = redactSensitiveText(input);
    expect(output).toBe(
      JSON.stringify(
        JSON.stringify({ token: REDACTED_EVENT_VALUE, message: "hello" }),
      ),
    );
    expect(JSON.parse(JSON.parse(output))).toEqual({
      token: REDACTED_EVENT_VALUE,
      message: "hello",
    });
  });

  it("redacts a trailing literal backslash and keeps its neighbor", () => {
    const input = JSON.stringify(
      JSON.stringify({ token: "abc\\", message: "hello" }),
    );
    const output = redactSensitiveText(input);
    expect(output).toBe(
      JSON.stringify(
        JSON.stringify({ token: REDACTED_EVENT_VALUE, message: "hello" }),
      ),
    );
    expect(JSON.parse(JSON.parse(output))).toEqual({
      token: REDACTED_EVENT_VALUE,
      message: "hello",
    });
  });

  it("redacts a brace inside a value and keeps its neighbor", () => {
    const input = JSON.stringify(
      JSON.stringify({ token: "a}b", message: "hello" }),
    );
    const output = redactSensitiveText(input);
    expect(output).toBe(
      JSON.stringify(
        JSON.stringify({ token: REDACTED_EVENT_VALUE, message: "hello" }),
      ),
    );
    expect(JSON.parse(JSON.parse(output))).toEqual({
      token: REDACTED_EVENT_VALUE,
      message: "hello",
    });
  });

  it("keeps redacting multi-field escaped JSON on a second pass", () => {
    const once = redactSensitiveText(
      JSON.stringify(JSON.stringify({ token: "abc", message: "hello" })),
    );
    expect(redactSensitiveText(once)).toBe(once);
  });
});

describe("JSON fields with trailing backslashes redact", () => {
  it("redacts a JSON field value ending in a single backslash", () => {
    const output = redactSensitiveText('{"token":"SECRET\\"}');
    expect(output).toBe(`{"token":"${REDACTED_EVENT_VALUE}"}`);
    expect(JSON.parse(output)).toEqual({ token: REDACTED_EVENT_VALUE });
  });

  it("redacts a valid JSON value ending in a literal backslash", () => {
    const input = JSON.stringify({ token: "SECRET\\" });
    const output = redactSensitiveText(input);
    expect(output).toBe(JSON.stringify({ token: REDACTED_EVENT_VALUE }));
    expect(JSON.parse(output)).toEqual({ token: REDACTED_EVENT_VALUE });
  });

  it("redacts a Windows-style path value ending in a backslash", () => {
    const output = redactSensitiveText('{"token":"C:\\path\\"}');
    expect(output).toBe(`{"token":"${REDACTED_EVENT_VALUE}"}`);
  });

  it("redacts a trailing-backslash value and keeps its neighbor", () => {
    const output = redactSensitiveText(
      '{"token":"SECRET\\"","message":"hello"}',
    );
    expect(output).toBe(
      `{"token":"${REDACTED_EVENT_VALUE}","message":"hello"}`,
    );
    expect(JSON.parse(output)).toEqual({
      token: REDACTED_EVENT_VALUE,
      message: "hello",
    });
  });

  it("redacts a value ending in a multi-backslash run", () => {
    const output = redactSensitiveText('{"token":"abc\\\\\\"}');
    expect(output).toBe(`{"token":"${REDACTED_EVENT_VALUE}"}`);
  });

  it("keeps redacting trailing-backslash values on a second pass", () => {
    const once = redactSensitiveText('{"token":"SECRET\\"}');
    expect(redactSensitiveText(once)).toBe(once);
  });

  it("still redacts an escaped-quote value fully", () => {
    const output = redactSensitiveText('{"token":"pre\\"X"}');
    expect(output).toBe(`{"token":"${REDACTED_EVENT_VALUE}"}`);
  });
});

describe("JSON fields followed by sentence punctuation redact", () => {
  it("redacts a JSON field value followed by a period", () => {
    const output = redactSensitiveText('token: "SECRET123".');
    expect(output).toBe(`token: "${REDACTED_EVENT_VALUE}".`);
  });

  it("redacts a JSON field value inside a sentence ending with a period", () => {
    const output = redactSensitiveText(
      'Error: token: "SECRET123". Please retry.',
    );
    expect(output).toBe(
      `Error: token: "${REDACTED_EVENT_VALUE}". Please retry.`,
    );
  });

  it("redacts JSON field values followed by exclamation and question marks", () => {
    expect(redactSensitiveText('token: "SECRET123"!')).toBe(
      `token: "${REDACTED_EVENT_VALUE}"!`,
    );
    expect(redactSensitiveText('token: "SECRET123"?')).toBe(
      `token: "${REDACTED_EVENT_VALUE}"?`,
    );
  });
});

describe("escaped JSON fields with embedded quotes redact fully", () => {
  it("redacts an embedded quote followed by a comma and keeps the neighbor", () => {
    const input = JSON.stringify(
      JSON.stringify({ token: 'pre",SENSITIVE', message: "hello" }),
    );
    const output = redactSensitiveText(input);
    expect(output).toBe(
      JSON.stringify(
        JSON.stringify({ token: REDACTED_EVENT_VALUE, message: "hello" }),
      ),
    );
    expect(JSON.parse(JSON.parse(output))).toEqual({
      token: REDACTED_EVENT_VALUE,
      message: "hello",
    });
    expect(output).not.toContain("SENSITIVE");
  });

  it("redacts an embedded quote followed by whitespace and keeps the neighbor", () => {
    const input = JSON.stringify(
      JSON.stringify({ token: 'pre" X', message: "hello" }),
    );
    const output = redactSensitiveText(input);
    expect(output).toBe(
      JSON.stringify(
        JSON.stringify({ token: REDACTED_EVENT_VALUE, message: "hello" }),
      ),
    );
    expect(JSON.parse(JSON.parse(output))).toEqual({
      token: REDACTED_EVENT_VALUE,
      message: "hello",
    });
  });

  it("redacts two escaped secret fields when the first has an embedded quote", () => {
    const input = JSON.stringify(
      JSON.stringify({ token: 'pre",X', password: "hunter2" }),
    );
    const output = redactSensitiveText(input);
    expect(output).toBe(
      JSON.stringify(
        JSON.stringify({
          token: REDACTED_EVENT_VALUE,
          password: REDACTED_EVENT_VALUE,
        }),
      ),
    );
    expect(output).not.toContain("hunter2");
  });

  it("keeps redacting an embedded-quote escaped value on a second pass", () => {
    const once = redactSensitiveText(
      JSON.stringify(
        JSON.stringify({ token: 'pre",SENSITIVE', message: "hello" }),
      ),
    );
    expect(redactSensitiveText(once)).toBe(once);
  });
});
