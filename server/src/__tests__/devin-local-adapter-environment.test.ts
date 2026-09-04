import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { testEnvironment } from "@paperclipai/adapter-devin-local/server";

const FAKE_DEVIN_SCRIPT = `#!/bin/sh
case "$1" in
  version)
    echo "devin 1.2.3-test"
    ;;
  --help)
    printf 'Usage: devin [options]\\n  -p, --print   print mode\\n      --export   export ATIF transcript\\n'
    ;;
  models)
    echo '{"families":[{"family_label":"SWE","family_uid":"swe","slug":"swe","aliases":[],"variants":[{"model_uid":"swe-1.7","label":"SWE 1.7","max_context_tokens":200000,"max_output_tokens":64000,"cost_tier":"Free","cost_summary":null,"is_new":false,"is_beta":false}]}]}'
    ;;
esac
`;

async function writeFakeDevin(dir: string): Promise<string> {
  const bin = path.join(dir, "devin");
  await fs.writeFile(bin, FAKE_DEVIN_SCRIPT, { mode: 0o755 });
  return bin;
}

describe("devin_local environment diagnostics", () => {
  it("reports a missing CLI as a blocking error", async () => {
    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "devin_local",
      config: {
        command: path.join(os.tmpdir(), "paperclip-devin-local-missing-cli"),
        cwd: os.tmpdir(),
      },
    });

    expect(result.status).toBe("fail");
    expect(
      result.checks.some((c) => c.level === "error" && c.code === "devin_command_missing"),
    ).toBe(true);
  });

  it("rejects a relative working directory", async () => {
    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "devin_local",
      config: {
        command: path.join(os.tmpdir(), "paperclip-devin-local-missing-cli"),
        cwd: "relative/path",
      },
    });

    expect(result.status).toBe("fail");
    expect(result.checks.some((c) => c.level === "error" && c.code === "invalid_cwd")).toBe(true);
  });

  it("passes with a working CLI, valid cwd, and AGENTS.md present", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-devin-local-env-"));
    const fakeBin = await writeFakeDevin(root);
    const cwd = path.join(root, "workspace");
    await fs.mkdir(cwd);
    await fs.writeFile(path.join(cwd, "AGENTS.md"), "# test workspace\n");

    try {
      const result = await testEnvironment({
        companyId: "company-1",
        adapterType: "devin_local",
        config: { command: fakeBin, cwd },
      });

      expect(result.checks.some((c) => c.level === "error")).toBe(false);
      for (const code of [
        "devin_command_resolvable",
        "cwd_valid",
        "agents_md_present",
        "devin_models_list_ok",
        "devin_print_export_supported",
      ]) {
        expect(
          result.checks.some((c) => c.level === "info" && c.code === code),
          `expected info check ${code}`,
        ).toBe(true);
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
