import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const dockerfile = readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");
const dockerWorkflow = readFileSync(path.join(repoRoot, ".github/workflows/docker.yml"), "utf8");
const dockerAgentWorkflow = readFileSync(path.join(repoRoot, ".github/workflows/docker-agent.yml"), "utf8");

describe("production Dockerfile k8s adapter runtime pins", () => {
  it("pins opencode-ai and asserts the installed version", () => {
    expect(dockerfile).toContain("ARG OPENCODE_AI_VERSION=1.4.3");
    expect(dockerfile).toContain('"opencode-ai@${OPENCODE_AI_VERSION}"');
    expect(dockerfile).toContain('test "$(opencode --version)" = "${OPENCODE_AI_VERSION}"');
    expect(dockerfile).not.toMatch(/npm install[^\n]*\sopencode-ai(?:\s|\\)/);
  });

  it("vendors the claude_k8s adapter commit with shared MCP baseline injection and resume guard", () => {
    expect(dockerfile).toContain("ARG CLAUDE_K8S_REF=af5df8448e02f3b152ddb0d8e40c558d371a0ebd");
    expect(dockerfile).toContain("always materialize the shared MCP baseline");
    expect(dockerfile).toContain("Fixes BackendEngineerGo/Ally missing paperclip/hindsight/gbrain/linear/etc.");
    expect(dockerfile).toContain("only pass --resume to Claude when the");
    expect(dockerfile).toContain("No conversation found with session ID");
  });

  it("vendors the opencode_k8s adapter commit with crash, runtime-cache, MCP header, and pod-stderr fixes", () => {
    expect(dockerfile).toContain("ARG OPENCODE_K8S_REF=4b195304acfd7c5b693b2cfeb9a6cc9fdcda98dd");
    expect(dockerfile).toContain("type-crash");
    expect(dockerfile).toContain("5-strike adapter crashloop circuit-breaker");
    expect(dockerfile).toContain("writable home (/paperclip/.runtime-cache)");
    expect(dockerfile).toContain("EACCES mkdir '/runtime-cache'");
    expect(dockerfile).toContain("preserve headers when translating Claude-style");
    expect(dockerfile).toContain("Bearer-protected gbrain connects");
    expect(dockerfile).toContain("recover the failed");
    expect(dockerfile).toContain("pod's container stderr");
  });

  it("routes Paperclip Docker deploy builds through the dedicated deploy runner pool", () => {
    expect(dockerWorkflow.match(/runs-on: arc-deploy/g)).toHaveLength(2);
    expect(dockerAgentWorkflow.match(/runs-on: arc-deploy/g)).toHaveLength(1);
    expect(dockerWorkflow).not.toContain("runs-on: self-hosted");
    expect(dockerAgentWorkflow).not.toContain("runs-on: self-hosted");
  });
});
