import { describe, expect, it } from "vitest";
import {
  detectRuntimeCommandPreflightViolation,
  RUNTIME_COMMAND_PREFLIGHT_REFUSAL_MESSAGE,
} from "./runtime-command-preflight.js";

function blocked(command: string, args: string[] = []) {
  return detectRuntimeCommandPreflightViolation({ command, args });
}

describe("runtime command preflight", () => {
  it("blocks direct broad environment dump commands", () => {
    expect(blocked("env")).toMatchObject({ code: "broad_runtime_env_inspection" });
    expect(blocked("/usr/bin/env", ["TOKEN=value"])).toMatchObject({ code: "broad_runtime_env_inspection" });
    expect(blocked("printenv")).toMatchObject({ code: "broad_runtime_env_inspection" });
    expect(blocked("printenv", ["PAPERCLIP_API_KEY"])).toMatchObject({ code: "broad_runtime_env_inspection" });
  });

  it("allows env when it is only wrapping a child command", () => {
    expect(blocked("env", ["-u", "DATABASE_URL", "node", "--version"])).toBeNull();
    expect(blocked("/usr/bin/env", ["FOO=bar", "node", "--version"])).toBeNull();
  });

  it("blocks env wrappers when the child command would dump the environment", () => {
    expect(blocked("env", ["-u", "DATABASE_URL", "printenv"])).toMatchObject({
      code: "broad_runtime_env_inspection",
    });
    expect(blocked("env", ["-S", "printenv"])).toMatchObject({
      code: "broad_runtime_env_inspection",
    });
  });

  it("blocks shell built-in dump forms while allowing shell options and assignments", () => {
    expect(blocked("sh", ["-lc", "set"])).toMatchObject({ code: "broad_runtime_env_inspection" });
    expect(blocked("bash", ["-lc", "set | rg '^PAPERCLIP_'"])).toMatchObject({ code: "broad_runtime_env_inspection" });
    expect(blocked("bash", ["-lc", "export"])).toMatchObject({ code: "broad_runtime_env_inspection" });
    expect(blocked("bash", ["-lc", "export -p | grep PAPERCLIP_"])).toMatchObject({
      code: "broad_runtime_env_inspection",
    });
    expect(blocked("bash", ["-lc", "set -euo pipefail; echo ok"])).toBeNull();
    expect(blocked("bash", ["-lc", "export SAFE_VALUE=ok; echo ok"])).toBeNull();
  });

  it("blocks proc environ reads before command execution", () => {
    expect(blocked("cat", ["/proc/self/environ"])).toMatchObject({ code: "broad_runtime_env_inspection" });
    expect(blocked("sh", ["-lc", "tr '\\0' '\\n' < /proc/123/environ"])).toMatchObject({
      code: "broad_runtime_env_inspection",
    });
  });

  it("returns a fixed safe refusal message without command or environment values", () => {
    const violation = blocked("sh", ["-lc", "env | rg PAPERCLIP_"]);
    expect(violation?.safeMessage).toBe(RUNTIME_COMMAND_PREFLIGHT_REFUSAL_MESSAGE);
    expect(violation?.safeMessage).not.toContain("PAPERCLIP_");
    expect(violation?.safeMessage).toContain("heartbeat context");
    expect(violation?.safeMessage).toContain("synthetic sentinel evidence");
  });
});
