import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";

import {
  collectDependencyProblems,
  resolveSmokeTempParent,
  validateReleaseDependencyGraph,
} from "./check-release-runtime-smoke.mjs";

function pkg(name, version, dependencies = {}) {
  return {
    name,
    version,
    pkg: {
      name,
      version,
      dependencies,
    },
  };
}

test("dependency validation fails on workspace dependency leakage", () => {
  const problems = collectDependencyProblems([
    pkg("paperclipai", "1.0.0", { "@paperclipai/server": "workspace:*" }),
    pkg("@paperclipai/server", "1.0.0", { "@paperclipai/shared": "1.0.0" }),
    pkg("@paperclipai/shared", "1.0.0"),
  ]);

  assert.match(problems.join("\n"), /paperclipai@1\.0\.0 has dependencies\.@paperclipai\/server=workspace:\*/);
});

test("dependency validation fails when paperclipai is missing server dependency", () => {
  const problems = collectDependencyProblems([
    pkg("paperclipai", "1.0.0"),
    pkg("@paperclipai/server", "1.0.0", { "@paperclipai/shared": "1.0.0" }),
    pkg("@paperclipai/shared", "1.0.0"),
  ]);

  assert.match(problems.join("\n"), /paperclipai@1\.0\.0 must depend on @paperclipai\/server@1\.0\.0/);
});

test("dependency validation fails when server is missing shared dependency", () => {
  const problems = collectDependencyProblems([
    pkg("paperclipai", "1.0.0", { "@paperclipai/server": "1.0.0" }),
    pkg("@paperclipai/server", "1.0.0"),
    pkg("@paperclipai/shared", "1.0.0"),
  ]);

  assert.match(problems.join("\n"), /@paperclipai\/server@1\.0\.0 must depend on @paperclipai\/shared@1\.0\.0/);
});

test("dependency validation fails on stale server shared dependency version", () => {
  const problems = collectDependencyProblems([
    pkg("paperclipai", "1.0.0", { "@paperclipai/server": "1.0.0" }),
    pkg("@paperclipai/server", "1.0.0", { "@paperclipai/shared": "0.9.0" }),
    pkg("@paperclipai/shared", "1.0.0"),
  ]);

  assert.match(
    problems.join("\n"),
    /@paperclipai\/server@1\.0\.0 has dependencies\.@paperclipai\/shared=0\.9\.0, but the tested package is @paperclipai\/shared@1\.0\.0/,
  );
});

test("dependency validation accepts matching paperclipai server shared chain", () => {
  assert.doesNotThrow(() => validateReleaseDependencyGraph([
    pkg("paperclipai", "1.0.0", { "@paperclipai/server": "1.0.0" }),
    pkg("@paperclipai/server", "1.0.0", { "@paperclipai/shared": "1.0.0" }),
    pkg("@paperclipai/shared", "1.0.0"),
  ]));
});

test("runtime smoke temp parent supports env override", () => {
  assert.equal(
    resolveSmokeTempParent({ PAPERCLIP_RELEASE_RUNTIME_SMOKE_TMPDIR: "custom-smoke-tmp" }),
    resolve("custom-smoke-tmp"),
  );
});
