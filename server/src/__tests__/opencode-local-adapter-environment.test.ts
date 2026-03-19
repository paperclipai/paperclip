import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { testEnvironment } from "@paperclipai/adapter-opencode-local/server";

describe("opencode_local environment diagnostics", () => {
  it("reports a missing working directory as an error when cwd is absolute", async () => {
    const cwd = path.join(
      os.tmpdir(),
      `paperclip-opencode-local-cwd-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      "workspace",
    );

    await fs.rm(path.dirname(cwd), { recursive: true, force: true });

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "opencode_local",
      config: {
        command: process.execPath,
        cwd,
      },
    });

    expect(result.checks.some((check) => check.code === "opencode_cwd_invalid")).toBe(true);
    expect(result.checks.some((check) => check.level === "error")).toBe(true);
    expect(result.status).toBe("fail");
  });

  it("treats an empty OPENAI_API_KEY override as missing", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-env-empty-key-"));
    const originalOpenAiKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-host-value";

    try {
      const result = await testEnvironment({
        companyId: "company-1",
        adapterType: "opencode_local",
        config: {
          command: process.execPath,
          cwd,
          env: {
            OPENAI_API_KEY: "",
          },
        },
      });

      const missingCheck = result.checks.find((check) => check.code === "opencode_openai_api_key_missing");
      expect(missingCheck).toBeTruthy();
      expect(missingCheck?.hint).toContain("empty");
    } finally {
      if (originalOpenAiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = originalOpenAiKey;
      }
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it("classifies ProviderModelNotFoundError probe output as model-unavailable warning", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-env-probe-cwd-"));
    const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-env-probe-bin-"));
    const fakeOpencode = path.join(binDir, "opencode");
    const script = [
      "#!/bin/sh",
      "if [ \"$1\" = \"models\" ]; then",
      "  echo 'openai/gpt-5.3-codex'",
      "  exit 0",
      "fi",
      "if [ \"$1\" = \"run\" ]; then",
      "  echo 'ProviderModelNotFoundError: ProviderModelNotFoundError' 1>&2",
      "  echo 'data: { providerID: \"openai\", modelID: \"gpt-5.3-codex\", suggestions: [] }' 1>&2",
      "  exit 1",
      "fi",
      "exit 1",
      "",
    ].join("\n");

    try {
      await fs.writeFile(fakeOpencode, script, "utf8");
      await fs.chmod(fakeOpencode, 0o755);

      const result = await testEnvironment({
        companyId: "company-1",
        adapterType: "opencode_local",
        config: {
          command: fakeOpencode,
          cwd,
          model: "openai/gpt-5.3-codex",
        },
      });

      const modelCheck = result.checks.find((check) => check.code === "opencode_hello_probe_model_unavailable");
      expect(modelCheck).toBeTruthy();
      expect(modelCheck?.level).toBe("warn");
      expect(result.status).toBe("warn");
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
      await fs.rm(binDir, { recursive: true, force: true });
    }
  });

  it("validates configured OpenCode agent profiles and probes with --agent", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-env-agent-cwd-"));
    const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-env-agent-bin-"));
    const fakeOpencode = path.join(binDir, "opencode");
    const script = [
      "#!/bin/sh",
      "if [ \"$1\" = \"agent\" ] && [ \"$2\" = \"list\" ]; then",
      "  echo 'Available Agents:'",
      "  echo '- plan (Planning agent)'",
      "  exit 0",
      "fi",
      "if [ \"$1\" = \"models\" ]; then",
      "  echo 'litellm/qwen3.5-35b-a3b'",
      "  exit 0",
      "fi",
      "if [ \"$1\" = \"run\" ]; then",
      "  agent_flag=''",
      "  while [ $# -gt 0 ]; do",
      "    if [ \"$1\" = \"--agent\" ]; then",
      "      shift",
      "      agent_flag=\"$1\"",
      "    fi",
      "    shift",
      "  done",
      "  if [ \"$agent_flag\" != 'plan' ]; then",
      "    echo 'missing expected --agent plan' 1>&2",
      "    exit 1",
      "  fi",
      "  printf '%s\n' '{\"type\":\"text\",\"sessionID\":\"ses_agent\",\"part\":{\"text\":\"hello\"}}'",
      "  printf '%s\n' '{\"type\":\"step_finish\",\"sessionID\":\"ses_agent\",\"part\":{\"cost\":0,\"tokens\":{\"input\":1,\"output\":1,\"reasoning\":0,\"cache\":{\"read\":0}}}}'",
      "  exit 0",
      "fi",
      "exit 1",
      "",
    ].join("\n");

    try {
      await fs.writeFile(fakeOpencode, script, "utf8");
      await fs.chmod(fakeOpencode, 0o755);

      const result = await testEnvironment({
        companyId: "company-1",
        adapterType: "opencode_local",
        config: {
          command: fakeOpencode,
          cwd,
          agent: "plan",
        },
      });

      expect(result.checks.some((check) => check.code === "opencode_agent_configured")).toBe(true);
      expect(result.checks.some((check) => check.code === "opencode_hello_probe_passed")).toBe(true);
      expect(result.status).toBe("pass");
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
      await fs.rm(binDir, { recursive: true, force: true });
    }
  });
});
