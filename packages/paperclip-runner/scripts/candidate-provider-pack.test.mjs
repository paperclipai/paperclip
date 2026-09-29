import test from "node:test";
import assert from "node:assert/strict";
import { parseProviderPackArguments, materializeCandidateProviderPack } from "./candidate-provider-pack.mjs";

test("candidate builds are explicit and leave qualified-only builds unchanged", () => {
  assert.deepEqual(parseProviderPackArguments(["--", "/pack"]), { output: "/pack", candidates: [] });
  assert.deepEqual(parseProviderPackArguments(["/pack", "--candidate-providers=pi,cursor"]), { output: "/pack", candidates: ["pi", "cursor"] });
});
test("candidate builder cannot admit unknown providers, options or duplicate assets", async () => {
  for (const args of [["--candidate-providers=cursor,cursor"], ["--candidate-providers=other"], ["--executable=/tmp/x"], ["/one", "/two"]]) {
    assert.throws(() => parseProviderPackArguments(args));
  }
  await assert.rejects(materializeCandidateProviderPack({ provider: "arbitrary", outputRoot: "/tmp/unused" }), /Unknown candidate/);
});
