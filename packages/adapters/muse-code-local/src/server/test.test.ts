import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { testEnvironment } from "./test.js";

const FAKE_MUSE = `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "Muse Code 9.9.9 (fake)"
  exit 0
fi
if [ "$1" = "exec" ]; then
  echo '{"stream":{"kind":"session","id":"probe-session"},"payload_type":"run.output.delta","payload":{"kind":"run_output_delta","text":"hello"}}'
  echo '{"stream":{"kind":"session","id":"probe-session"},"payload_type":"run.terminal.completed","payload":{"kind":"run_terminal","terminal":"completed","text":"hello","reason":null}}'
  exit 0
fi
echo "unexpected args: $@" >&2
exit 2
`;

describe("Muse testEnvironment", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-muse-envtest-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("passes the hello probe against a working muse command", async () => {
    const command = path.join(dir, "muse");
    await fs.writeFile(command, FAKE_MUSE, { mode: 0o755 });

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "muse_code_local",
      config: { command, cwd: dir },
    } as never);

    expect(result.checks).toContainEqual(
      expect.objectContaining({ code: "muse_code_cli_detected", level: "info" }),
    );
    expect(result.checks).toContainEqual(
      expect.objectContaining({ code: "muse_code_hello_probe_passed", level: "info" }),
    );
  });

  it("probes in a temp workspace when no cwd is configured", async () => {
    const command = path.join(dir, "muse");
    const pwdFile = path.join(dir, "probe-pwd.txt");
    const script = `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "Muse Code 9.9.9 (fake)"
  exit 0
fi
printf '%s' "$PWD" > "$PROBE_PWD_FILE"
echo '{"stream":{"kind":"session","id":"probe-session"},"payload_type":"run.terminal.completed","payload":{"kind":"run_terminal","terminal":"completed","text":"hello","reason":null}}'
exit 0
`;
    await fs.writeFile(command, script, { mode: 0o755 });

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "muse_code_local",
      config: { command, env: { PROBE_PWD_FILE: pwdFile } },
    } as never);

    expect(result.checks).toContainEqual(
      expect.objectContaining({ code: "muse_code_hello_probe_passed" }),
    );
    const probeCwd = await fs.readFile(pwdFile, "utf8");
    expect(probeCwd).not.toBe(process.cwd());
    expect(probeCwd).toContain("paperclip-muse-probe-");
  });

  it("reports a rejected META_API_KEY as an auth problem, not a generic failure", async () => {
    const command = path.join(dir, "muse");
    const script = `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "Muse Code 9.9.9 (fake)"
  exit 0
fi
echo '{"stream":{"kind":"session","id":"probe-session"},"payload_type":"run.terminal.failed","payload":{"kind":"run_terminal","terminal":"failed","text":"","reason":"your API key from META_API_KEY was rejected — update or unset it"}}'
echo "run ended with Failed: your API key from META_API_KEY was rejected — update or unset it" >&2
exit 1
`;
    await fs.writeFile(command, script, { mode: 0o755 });

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "muse_code_local",
      config: { command, cwd: dir, env: { META_API_KEY: "bad-key" } },
    } as never);

    expect(result.checks).toContainEqual(
      expect.objectContaining({
        code: "muse_code_hello_probe_auth_required",
        level: "warn",
        detail: expect.stringContaining("META_API_KEY was rejected"),
      }),
    );
  });

  it("fails when the muse command is missing", async () => {
    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "muse_code_local",
      config: { command: path.join(dir, "no-such-muse"), cwd: dir },
    } as never);

    expect(result.status).toBe("fail");
    expect(result.checks).toContainEqual(
      expect.objectContaining({ code: "muse_code_cli_not_found", level: "error" }),
    );
  });
});
