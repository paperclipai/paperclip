import { test } from "node:test";
import assert from "node:assert/strict";

import {
  classifyPath,
  collectWritePathViolations,
  extractVarToken,
  runCheck,
} from "./check-literal-var-write-paths.mjs";

test("rejects an unexpanded shell variable segment (the TSMC-19768 case)", () => {
  const v = classifyPath(
    "server/$PAPERCLIP_WORK_PRODUCTS_DIR/TSR-4961/01-it-support-desk-manager-tailored-cv.md",
  );
  assert.ok(v, "expected a violation");
  assert.equal(v.kind, "unexpanded-variable");
  assert.match(v.message, /\$PAPERCLIP_WORK_PRODUCTS_DIR/);
});

test("rejects ${BRACED} and %WINDOWS% variable forms", () => {
  assert.equal(classifyPath("a/${HOME}/b.txt")?.kind, "unexpanded-variable");
  assert.equal(classifyPath("a/%USERPROFILE%/b.txt")?.kind, "unexpanded-variable");
});

test("extractVarToken pulls the full token for the error message", () => {
  assert.equal(
    extractVarToken("x/$PAPERCLIP_WORK_PRODUCTS_DIR/y"),
    "$PAPERCLIP_WORK_PRODUCTS_DIR",
  );
  assert.equal(extractVarToken("x/${HOME}/y"), "${HOME}");
  assert.equal(extractVarToken("x/%VAR%/y"), "%VAR%");
});

test("rejects recruitment-PII deliverables by filename token", () => {
  assert.equal(
    classifyPath("work-products/TSR-1/some-tailored-cv.md")?.kind,
    "candidate-pii-in-repo",
  );
  assert.equal(
    classifyPath("x/y/my-cover-letter.pdf")?.kind,
    "candidate-pii-in-repo",
  );
  assert.equal(
    classifyPath("z/application-pack-final.docx")?.kind,
    "candidate-pii-in-repo",
  );
});

test("does NOT false-positive on tracked 'candidate-' collisions", () => {
  // High-precision guard: these are legitimately tracked and must stay committable.
  assert.equal(classifyPath("benchmark/skillbench/candidate-skills/site-composer.md"), null);
  assert.equal(
    classifyPath("server/work-products/TSM-5381/2026-07-10/candidate-01-evidence-board.mp4"),
    null,
  );
});

test("allows legitimate tracked work-products in the served tree", () => {
  // These are real tracked assets in server/work-products/ — must NOT be flagged.
  assert.equal(classifyPath("server/work-products/DP-3611-AA-product-photo-pack.md"), null);
  assert.equal(
    classifyPath(
      "server/work-products/4d285be8/logoforge-locked-marks/cashflow-v7-lock.json",
    ),
    null,
  );
  assert.equal(classifyPath("packages/adapter-utils/src/server-utils.ts"), null);
});

test("does not flag incidental '$' that is not a variable start", () => {
  // A '$' not followed by a var-name character is not a shell var.
  assert.equal(classifyPath("src/cost$.ts"), null);
});

test("collectWritePathViolations returns every offending path", () => {
  const violations = collectWritePathViolations([
    "ok/file.ts",
    "server/$PAPERCLIP_WORK_PRODUCTS_DIR/DP-4022/review-card-tg.md",
    "work-products/x/y-tailored-cv.md",
  ]);
  assert.equal(violations.length, 2);
});

test("runCheck returns 0 on clean input and 1 on a violation", () => {
  const quiet = () => {};
  assert.equal(runCheck({ paths: ["a/b.ts"], log: quiet, error: quiet }), 0);
  assert.equal(
    runCheck({ paths: ["a/$VAR/b.ts"], log: quiet, error: quiet }),
    1,
  );
});
