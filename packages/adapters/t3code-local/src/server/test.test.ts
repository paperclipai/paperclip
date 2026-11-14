import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { testEnvironment } from "./test.js";

const roots: string[] = [];

async function fakeT3(listStderr: string | null) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-t3code-envtest-"));
  roots.push(root);
  const command = path.join(root, "t3");
  await fs.writeFile(command, [
    "#!/bin/sh",
    "if [ \"$1\" = \"--version\" ]; then echo 0.0.27; exit 0; fi",
    listStderr === null ? "echo '[]'; exit 0" : `echo '${listStderr}' >&2; exit 1`,
    "",
  ].join("\n"), { mode: 0o755 });
  return { command, cwd: root };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("t3code_local testEnvironment", () => {
  it("passes when the CLI runs and the server answers", async () => {
    const result = await testEnvironment({ companyId: "c", adapterType: "t3code_local", config: await fakeT3(null) });
    expect(result.status).toBe("pass");
    expect(result.checks.map((check) => check.code)).toEqual(["t3code_version", "t3code_server_reachable"]);
  });

  it("explains how to start a server that is not running", async () => {
    const config = await fakeT3("No running T3 Code server uses /home/u/.t3. Start T3 Code, then retry.");
    const result = await testEnvironment({ companyId: "c", adapterType: "t3code_local", config });
    expect(result.status).toBe("fail");
    expect(result.checks.at(-1)).toMatchObject({
      code: "t3code_server_unreachable",
      message: "No T3 Code server is running for this user.",
      hint: expect.stringContaining("t3 serve"),
    });
  });

  it("rejects remote execution targets", async () => {
    const result = await testEnvironment({
      companyId: "c",
      adapterType: "t3code_local",
      config: {},
      executionTarget: { kind: "remote" } as never,
    });
    expect(result.checks[0]?.code).toBe("t3code_local_only");
  });
});
