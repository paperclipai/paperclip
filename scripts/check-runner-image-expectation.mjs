#!/usr/bin/env node

import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const EXPECT_INPUTS_DIGEST_VARIABLE = "PAPERCLIP_RUNNER_EXPECT_INPUTS_DIGEST";

export function runnerImageExpectationProblem(image, expected) {
  if (expected === "") return null;
  if (!/^[0-9a-f]{64}$/.test(expected)) {
    return `${EXPECT_INPUTS_DIGEST_VARIABLE} must be the 64 hexadecimal characters of a Runner inputs digest, not ${JSON.stringify(expected)}.`;
  }
  const found = image?.inputsDigest?.digest;
  if (image?.publication === true && found === expected) return null;
  const actual = image?.publication === true ? `have the inputs ${found ?? "(none)"}` : "are not a published Runner image";
  return `${EXPECT_INPUTS_DIGEST_VARIABLE} is ${expected}, but the runner-artifacts of this build ${actual}. `
    + "Pass the image of those inputs as --build-context runner-artifacts=..., or unset the argument.";
}

export function checkRunnerImageExpectation(file, { env = process.env, read = readFileSync, log = console.error } = {}) {
  const expected = env[EXPECT_INPUTS_DIGEST_VARIABLE] ?? "";
  if (expected === "") return 0;
  const problem = runnerImageExpectationProblem(JSON.parse(read(file, "utf8")), expected);
  if (problem === null) return 0;
  log(`ERROR: ${problem}`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const file = process.argv[2];
  if (!file || process.argv.length !== 3) {
    console.error("Usage: check-runner-image-expectation.mjs <runner-image.json>");
    process.exit(2);
  }
  process.exit(checkRunnerImageExpectation(file));
}
