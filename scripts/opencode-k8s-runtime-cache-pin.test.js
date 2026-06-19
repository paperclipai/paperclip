import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
const opencodeRefMatch = dockerfile.match(/^ARG OPENCODE_K8S_REF=([0-9a-f]{40})$/m);

test("Dockerfile pins opencode_k8s to the merged runtime-cache adapter", () => {
  assert.equal(opencodeRefMatch?.[1], "861227d3d0726b43bf7e4a5421d076e3ab8de0af");
  assert.match(dockerfile, /mount a per-agent\s*\n# \/runtime-cache emptyDir/);
  assert.match(dockerfile, /kkroo\/paperclip-adapter-opencode-k8s#29/);
  assert.doesNotMatch(dockerfile, /OPENCODE_K8S_REF=cac7d0b53fa420beb756919561004f1b5b709fa2/);
});
