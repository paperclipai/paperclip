import assert from "node:assert/strict";
import test from "node:test";
import { hermesProvisioningConfig } from "./hermes-provisioning-config.mjs";

test("preserves pinned resolver context without selecting unrelated project tables", () => {
  const settings = 'override-dependencies = ["cryptography>=50,<51"]\nexclude-newer = "14 days"\n\n[exclude-newer-package]\nanthropic = false\n';
  assert.equal(hermesProvisioningConfig('[project]\nname = "hermes-agent"\n[tool.uv]\n' + settings.replace("[exclude-newer-package]", "[tool.uv.exclude-newer-package]") + '[tool.setuptools]\npackages = ["ambient"]\n'), settings);
});

test("rejects missing, repeated or unsupported pinned uv table layouts", () => {
  for (const source of ['[project]\nname = "hermes-agent"', '[tool.uv]\n[tool.uv]\n', '[tool.uv]\n[tool.uv."unsupported"]\n']) {
    assert.throws(() => hermesProvisioningConfig(source), /pinned/);
  }
});
