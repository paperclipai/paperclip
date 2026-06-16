import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const dockerfile = readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");

describe("production Dockerfile OpenCode runtime pin", () => {
  it("pins opencode-ai and asserts the installed version", () => {
    expect(dockerfile).toContain("ARG OPENCODE_AI_VERSION=1.4.3");
    expect(dockerfile).toContain('"opencode-ai@${OPENCODE_AI_VERSION}"');
    expect(dockerfile).toContain('test "$(opencode --version)" = "${OPENCODE_AI_VERSION}"');
    expect(dockerfile).not.toMatch(/npm install[^\n]*\sopencode-ai(?:\s|\\)/);
  });

  it("vendors the opencode_k8s adapter commit with response-type crash classification", () => {
    expect(dockerfile).toContain("ARG OPENCODE_K8S_REF=82c3cb25e9112c8197f7001a84d0c6cbf6f386ff");
    expect(dockerfile).toContain("type-crash");
    expect(dockerfile).toContain("5-strike adapter crashloop circuit-breaker");
  });
});
