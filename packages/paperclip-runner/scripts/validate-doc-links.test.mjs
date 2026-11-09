import assert from "node:assert/strict";
import { test } from "node:test";

import { wrapperMarkupIn } from "./lib/doc-wrappers.mjs";

test("clean prose reports no leaked generation-wrapper markup", () => {
  const markdown = [
    "# Title",
    "",
    "Body prose that talks about content and invoking tools without any tags.",
    "",
    "- [A link](other.md)",
    "",
  ].join("\n");

  assert.deepEqual(wrapperMarkupIn(markdown), []);
});

test("a trailing </content> wrapper is caught with its exact line", () => {
  const markdown = ["# Title", "", "Body.", "</content>"].join("\n");

  assert.deepEqual(wrapperMarkupIn(markdown), [{ line: 4, tag: "</content>" }]);
});

test("a tutorial's </invoke> wrapper is caught", () => {
  const markdown = ["Body.", "</content>", "</invoke>"].join("\n");

  assert.deepEqual(wrapperMarkupIn(markdown), [
    { line: 2, tag: "</content>" },
    { line: 3, tag: "</invoke>" },
  ]);
});

test("assorted generator envelope tags are all caught", () => {
  for (const tag of [
    "<content>",
    "<invoke name=\"Bash\">",
    "<parameter name=\"x\">",
    "<function_calls>",
    "</function_results>",
    "<invoke>",
  ]) {
    assert.deepEqual(wrapperMarkupIn(`prose\n${tag}\n`), [{ line: 2, tag }]);
  }
});
