import assert from "node:assert/strict";
import test from "node:test";

import { matchesGeneratedContent } from "./lib/generated-content.mjs";

const generated = "// Generated. Do not edit.\nexport const a = 1;\n";

test("accepts content identical to the generator output", () => {
  assert.equal(matchesGeneratedContent(generated, generated), true);
});

test("accepts a CRLF checkout of the generator output", () => {
  assert.equal(matchesGeneratedContent(generated.replace(/\n/g, "\r\n"), generated), true);
});

test("accepts expected output that picked up CRLF from a CRLF generator source", () => {
  const mixed = "// Generated. Do not edit.\r\nexport const a = 1;\n";
  assert.equal(matchesGeneratedContent(generated, mixed), true);
  assert.equal(matchesGeneratedContent(generated.replace(/\n/g, "\r\n"), mixed), true);
});

test("rejects content that really differs", () => {
  assert.equal(matchesGeneratedContent("// Generated. Do not edit.\nexport const a = 2;\n", generated), false);
  assert.equal(matchesGeneratedContent("", generated), false);
});

test("rejects stray carriage returns that are not part of a CRLF", () => {
  assert.equal(matchesGeneratedContent(generated.replace("a = 1", "a =\r 1"), generated), false);
});
