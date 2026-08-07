import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isAgentFallbackWorkspaceCwd,
  resolveDefaultAgentWorkspaceDir,
  resolveIssueScopedAgentWorkspaceDir,
} from "../home-paths.js";

// Pin the instance root to a deterministic temp home so the resolved paths are
// predictable regardless of the developer's real ~/.paperclip.
const FAKE_HOME = "/tmp/paperclip-fallback-ws-test-home";
const AGENT_ID = "b3b6dde7-d283-47b7-8556-9eafe7ca9b52";
const ISSUE_A = "c624b8f1-c69a-4ac2-8c73-33e2d6a945b1";
const ISSUE_B = "a1111111-2222-3333-4444-555555555555";

let savedHome: string | undefined;
let savedInstance: string | undefined;

beforeEach(() => {
  savedHome = process.env.PAPERCLIP_HOME;
  savedInstance = process.env.PAPERCLIP_INSTANCE_ID;
  process.env.PAPERCLIP_HOME = FAKE_HOME;
  delete process.env.PAPERCLIP_INSTANCE_ID; // → "default"
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.PAPERCLIP_HOME;
  else process.env.PAPERCLIP_HOME = savedHome;
  if (savedInstance === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
  else process.env.PAPERCLIP_INSTANCE_ID = savedInstance;
});

const workspacesRoot = () => path.resolve(FAKE_HOME, "instances", "default", "workspaces");

describe("resolveIssueScopedAgentWorkspaceDir", () => {
  it("keys the fallback dir by agent AND issue", () => {
    expect(resolveIssueScopedAgentWorkspaceDir(AGENT_ID, ISSUE_A)).toBe(
      path.join(workspacesRoot(), AGENT_ID, ISSUE_A),
    );
  });

  it("isolates the same agent's different issues into different dirs", () => {
    const a = resolveIssueScopedAgentWorkspaceDir(AGENT_ID, ISSUE_A);
    const b = resolveIssueScopedAgentWorkspaceDir(AGENT_ID, ISSUE_B);
    expect(a).not.toBe(b);
    // ...and neither collides with the shared per-agent dir that the pre-fix
    // fallback used (the root cause of cross-issue trampling).
    const perAgent = resolveDefaultAgentWorkspaceDir(AGENT_ID);
    expect(a).not.toBe(perAgent);
    expect(b).not.toBe(perAgent);
  });

  it("is stable across calls for the same (agent, issue) — enables heartbeat reuse", () => {
    expect(resolveIssueScopedAgentWorkspaceDir(AGENT_ID, ISSUE_A)).toBe(
      resolveIssueScopedAgentWorkspaceDir(AGENT_ID, ISSUE_A),
    );
  });

  it("nests the issue dir directly under the per-agent dir", () => {
    const issueDir = resolveIssueScopedAgentWorkspaceDir(AGENT_ID, ISSUE_A);
    expect(path.dirname(issueDir)).toBe(resolveDefaultAgentWorkspaceDir(AGENT_ID));
  });

  it("rejects path-traversal / non-segment ids", () => {
    expect(() => resolveIssueScopedAgentWorkspaceDir(AGENT_ID, "../escape")).toThrow();
    expect(() => resolveIssueScopedAgentWorkspaceDir(AGENT_ID, "a/b")).toThrow();
    expect(() => resolveIssueScopedAgentWorkspaceDir("bad id", ISSUE_A)).toThrow();
    expect(() => resolveIssueScopedAgentWorkspaceDir(AGENT_ID, "")).toThrow();
  });
});

describe("isAgentFallbackWorkspaceCwd", () => {
  it("recognizes the per-agent fallback dir", () => {
    expect(isAgentFallbackWorkspaceCwd(AGENT_ID, resolveDefaultAgentWorkspaceDir(AGENT_ID))).toBe(true);
  });

  it("recognizes an issue-scoped fallback subdir", () => {
    expect(isAgentFallbackWorkspaceCwd(AGENT_ID, resolveIssueScopedAgentWorkspaceDir(AGENT_ID, ISSUE_A))).toBe(true);
  });

  it("does not treat a different agent's issue-scoped dir as this agent's fallback", () => {
    const otherAgent = "ffffffff-0000-1111-2222-333333333333";
    expect(isAgentFallbackWorkspaceCwd(AGENT_ID, resolveIssueScopedAgentWorkspaceDir(otherAgent, ISSUE_A))).toBe(false);
  });

  it("rejects unrelated paths, deeper nesting, and empty input", () => {
    expect(isAgentFallbackWorkspaceCwd(AGENT_ID, "/some/project/workspace")).toBe(false);
    // Deeper than one level under the per-agent root is not a fallback dir we mint.
    expect(isAgentFallbackWorkspaceCwd(AGENT_ID, path.join(workspacesRoot(), AGENT_ID, ISSUE_A, "sub"))).toBe(false);
    expect(isAgentFallbackWorkspaceCwd(AGENT_ID, "")).toBe(false);
    expect(isAgentFallbackWorkspaceCwd(AGENT_ID, null)).toBe(false);
  });
});
