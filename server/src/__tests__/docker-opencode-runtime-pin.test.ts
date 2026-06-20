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
    expect(dockerfile).toContain("ARG OPENCODE_AI_VERSION=1.15.12");
    expect(dockerfile).toContain("reasoning output items");
    expect(dockerfile).toContain("UnknownError/exit 1");
    expect(dockerfile).toContain('"opencode-ai@${OPENCODE_AI_VERSION}"');
    expect(dockerfile).toContain('test "$(opencode --version)" = "${OPENCODE_AI_VERSION}"');
    expect(dockerfile).not.toMatch(/npm install[^\n]*\sopencode-ai(?:\s|\\)/);
  });

  it("vendors the claude_k8s adapter commit with shared MCP baseline injection and resume guard", () => {
    expect(dockerfile).toContain("ARG CLAUDE_K8S_REF=f79ab9a485006f1b4d31ffff063ab44198a5fe98");
    expect(dockerfile).toContain("always materialize the shared MCP baseline");
    expect(dockerfile).toContain("Fixes BackendEngineerGo/Ally missing paperclip/hindsight/gbrain/linear/etc.");
    expect(dockerfile).toContain("only pass --resume to Claude when the");
    expect(dockerfile).toContain("No conversation found with session ID");
  });

  it("vendors the opencode_k8s adapter commit with crash, runtime-cache, MCP header, pod-stderr, and per-agent runtime-cache fixes", () => {
    expect(dockerfile).toContain("ARG OPENCODE_K8S_REF=42d2d995a2f966e134f1b62a637497f9fe98c101");
    expect(dockerfile).toContain("type-crash");
    expect(dockerfile).toContain("5-strike adapter crashloop circuit-breaker");
    expect(dockerfile).toContain("writable home (/paperclip/.runtime-cache)");
    expect(dockerfile).toContain("EACCES mkdir '/runtime-cache'");
    expect(dockerfile).toContain("preserve headers when translating Claude-style");
    expect(dockerfile).toContain("Bearer-protected gbrain connects");
    expect(dockerfile).toContain("recover the failed");
    expect(dockerfile).toContain("pod's container stderr");
    expect(dockerfile).toContain("PEN-389");
    expect(dockerfile).toContain("mount a per-agent");
    expect(dockerfile).toContain("/runtime-cache emptyDir in opencode_k8s Jobs");
    expect(dockerfile).toContain("Chrome BrowserMetrics");
    expect(dockerfile).toContain("reserve the runtime-cache env keys");
    expect(dockerfile).toContain("stale /paperclip/.runtime-cache overrides");
  });

  it("routes Paperclip Docker deploy builds through the dedicated deploy runner pool", () => {
    expect(dockerWorkflow.match(/runs-on: arc-deploy/g)).toHaveLength(2);
    expect(dockerAgentWorkflow.match(/runs-on: arc-deploy/g)).toHaveLength(1);
    expect(dockerWorkflow).not.toContain("runs-on: self-hosted");
    expect(dockerAgentWorkflow).not.toContain("runs-on: self-hosted");
  });

  it("keeps the agent image build timeout above full toolchain rebuild duration", () => {
    expect(dockerAgentWorkflow).toContain("timeout-minutes: 90");
  });
});
