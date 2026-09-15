import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { REDACTED_EVENT_VALUE, redactSensitiveText } from "../redaction.js";

describe("redaction of large task text", () => {
  it("finishes long encoded briefs and identifiers without blocking the process", () => {
    // A child deadline can interrupt synchronous regexp backtracking; a Vitest
    // timeout cannot interrupt a regexp blocking this test's own event loop.
    const source = new URL("../redaction.ts", import.meta.url).href;
    const result = execFileSync(process.execPath, [
      "--import", createRequire(import.meta.url).resolve("tsx"), "--input-type=module", "-e",
      `import assert from 'node:assert/strict';
       import { redactSensitiveText, sanitizeRecord } from ${JSON.stringify(source)};
       const encoded = Buffer.from(JSON.stringify({fixture: 'ordinary fixture '.repeat(50_000)})).toString('base64');
       const text = 'Inspect this task.\\nimport base64\\n' + encoded;
       assert.equal(redactSensitiveText(text), text);
       const label = 'ordinary-'.repeat(100_000);
       assert.equal(redactSensitiveText('Task. ' + label + ': \"visible\"'), 'Task. ' + label + ': \"visible\"');
       const key = 'ordinary'.repeat(50_000);
       assert.deepEqual(sanitizeRecord({[key]: 'safe'}), {[key]: 'safe'});
       const diagnostic = key + ': "safe" token: "must-be-redacted"';
       assert(!redactSensitiveText(diagnostic).includes('must-be-redacted'));
       process.stdout.write('passed');`,
    ], { encoding: "utf8", timeout: 10_000, maxBuffer: 16 * 1024 });
    expect(result).toBe("passed");
  }, 15_000);

  it("still redacts secret fields inside ordinary quoted diagnostic values", () => {
    expect(redactSensitiveText(`message: "apiKey: 'nested-secret'"`))
      .toBe(`message: "apiKey: '${REDACTED_EVENT_VALUE}'"`);
    expect(redactSensitiveText(String.raw`message: \"apiKey: \"nested-secret\"\"`))
      .not.toContain("nested-secret");
    expect(redactSensitiveText(`normal: "visible" custom_auth_token: "secret-value"`))
      .toBe(`normal: "visible" custom_auth_token: "${REDACTED_EVENT_VALUE}"`);
  });
});
