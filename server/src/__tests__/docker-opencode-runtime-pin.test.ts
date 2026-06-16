import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const dockerfile = readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");

describe("production Dockerfile k8s adapter runtime pins", () => {
  it("pins opencode-ai and asserts the installed version", () => {
    expect(dockerfile).toContain("ARG OPENCODE_AI_VERSION=1.4.3");
    expect(dockerfile).toContain('"opencode-ai@${OPENCODE_AI_VERSION}"');
    expect(dockerfile).toContain('test "$(opencode --version)" = "${OPENCODE_AI_VERSION}"');
    expect(dockerfile).not.toMatch(/npm install[^\n]*\sopencode-ai(?:\s|\\)/);
  });

  it("vendors the claude_k8s adapter commit with shared MCP baseline injection", () => {
    expect(dockerfile).toContain("ARG CLAUDE_K8S_REF=6a7b9d532c8818c3bbd8777874dba9a7104e8fbf");
    expect(dockerfile).toContain("always materialize the shared MCP baseline");
    expect(dockerfile).toContain("Fixes BackendEngineerGo/Ally missing paperclip/hindsight/gbrain/linear/etc.");
  });

  it("vendors the opencode_k8s adapter commit with crash, runtime-cache, and MCP header fixes", () => {
    expect(dockerfile).toContain("ARG OPENCODE_K8S_REF=5d43c076e0232d9d11cdb2a9f0fce7aad7cfbdab");
    expect(dockerfile).toContain("type-crash");
    expect(dockerfile).toContain("5-strike adapter crashloop circuit-breaker");
    expect(dockerfile).toContain("writable home (/paperclip/.runtime-cache)");
    expect(dockerfile).toContain("EACCES mkdir '/runtime-cache'");
    expect(dockerfile).toContain("preserve headers when translating Claude-style");
    expect(dockerfile).toContain("Bearer-protected gbrain connects");
  });
});
