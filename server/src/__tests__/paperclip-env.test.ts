import { afterEach, describe, expect, it } from "vitest";
import { buildChildProcessEnv, buildPaperclipEnv } from "../adapters/utils.js";

const ORIGINAL_PAPERCLIP_API_URL = process.env.PAPERCLIP_API_URL;
const ORIGINAL_PAPERCLIP_LISTEN_HOST = process.env.PAPERCLIP_LISTEN_HOST;
const ORIGINAL_PAPERCLIP_LISTEN_PORT = process.env.PAPERCLIP_LISTEN_PORT;
const ORIGINAL_HOST = process.env.HOST;
const ORIGINAL_PORT = process.env.PORT;

afterEach(() => {
  if (ORIGINAL_PAPERCLIP_API_URL === undefined) delete process.env.PAPERCLIP_API_URL;
  else process.env.PAPERCLIP_API_URL = ORIGINAL_PAPERCLIP_API_URL;

  if (ORIGINAL_PAPERCLIP_LISTEN_HOST === undefined) delete process.env.PAPERCLIP_LISTEN_HOST;
  else process.env.PAPERCLIP_LISTEN_HOST = ORIGINAL_PAPERCLIP_LISTEN_HOST;

  if (ORIGINAL_PAPERCLIP_LISTEN_PORT === undefined) delete process.env.PAPERCLIP_LISTEN_PORT;
  else process.env.PAPERCLIP_LISTEN_PORT = ORIGINAL_PAPERCLIP_LISTEN_PORT;

  if (ORIGINAL_HOST === undefined) delete process.env.HOST;
  else process.env.HOST = ORIGINAL_HOST;

  if (ORIGINAL_PORT === undefined) delete process.env.PORT;
  else process.env.PORT = ORIGINAL_PORT;
});

describe("buildPaperclipEnv", () => {
  it("prefers an explicit PAPERCLIP_API_URL", () => {
    process.env.PAPERCLIP_API_URL = "http://localhost:4100";
    process.env.PAPERCLIP_LISTEN_HOST = "127.0.0.1";
    process.env.PAPERCLIP_LISTEN_PORT = "3101";

    const env = buildPaperclipEnv({ id: "agent-1", companyId: "company-1" });

    expect(env.PAPERCLIP_API_URL).toBe("http://localhost:4100");
  });

  it("uses runtime listen host/port when explicit URL is not set", () => {
    delete process.env.PAPERCLIP_API_URL;
    process.env.PAPERCLIP_LISTEN_HOST = "0.0.0.0";
    process.env.PAPERCLIP_LISTEN_PORT = "3101";
    process.env.PORT = "3100";

    const env = buildPaperclipEnv({ id: "agent-1", companyId: "company-1" });

    expect(env.PAPERCLIP_API_URL).toBe("http://localhost:3101");
  });

  it("formats IPv6 hosts safely in fallback URL generation", () => {
    delete process.env.PAPERCLIP_API_URL;
    process.env.PAPERCLIP_LISTEN_HOST = "::1";
    process.env.PAPERCLIP_LISTEN_PORT = "3101";

    const env = buildPaperclipEnv({ id: "agent-1", companyId: "company-1" });

    expect(env.PAPERCLIP_API_URL).toBe("http://[::1]:3101");
  });
});

describe("buildChildProcessEnv", () => {
  it("strips inherited worktree env from non-worktree child runs", () => {
    const env = buildChildProcessEnv(
      {
        PAPERCLIP_AGENT_ID: "agent-1",
        PAPERCLIP_COMPANY_ID: "company-1",
        PAPERCLIP_WORKSPACE_SOURCE: "agent_home",
      },
      {
        PATH: process.env.PATH,
        PAPERCLIP_IN_WORKTREE: "true",
        PAPERCLIP_WORKTREE_NAME: "PAP-884-ai-commits-component",
        PAPERCLIP_HOME: "/tmp/worktree-paperclip-home",
        PAPERCLIP_CONFIG: "/tmp/worktree-paperclip-home/config.json",
        PAPERCLIP_INSTANCE_ID: "pap-884-ai-commits-component",
        PAPERCLIP_CONTEXT: "/tmp/worktree-paperclip-home/context.json",
      },
    );

    expect(env.PAPERCLIP_IN_WORKTREE).toBeUndefined();
    expect(env.PAPERCLIP_WORKTREE_NAME).toBeUndefined();
    expect(env.PAPERCLIP_HOME).toBeUndefined();
    expect(env.PAPERCLIP_CONFIG).toBeUndefined();
    expect(env.PAPERCLIP_INSTANCE_ID).toBeUndefined();
    expect(env.PAPERCLIP_CONTEXT).toBeUndefined();
    expect(env.PAPERCLIP_WORKSPACE_SOURCE).toBe("agent_home");
  });

  it("preserves inherited worktree env when the child run explicitly resolves to a worktree", () => {
    const env = buildChildProcessEnv(
      {
        PAPERCLIP_AGENT_ID: "agent-1",
        PAPERCLIP_COMPANY_ID: "company-1",
        PAPERCLIP_WORKSPACE_STRATEGY: "git_worktree",
        PAPERCLIP_WORKSPACE_WORKTREE_PATH: "/tmp/worktrees/SUP-137-sanitize-worktree-env",
      },
      {
        PATH: process.env.PATH,
        PAPERCLIP_IN_WORKTREE: "true",
        PAPERCLIP_WORKTREE_NAME: "SUP-137-sanitize-worktree-env",
        PAPERCLIP_HOME: "/tmp/worktree-paperclip-home",
        PAPERCLIP_CONFIG: "/tmp/worktree-paperclip-home/config.json",
        PAPERCLIP_INSTANCE_ID: "sup-137-sanitize-worktree-env",
        PAPERCLIP_CONTEXT: "/tmp/worktree-paperclip-home/context.json",
      },
    );

    expect(env.PAPERCLIP_IN_WORKTREE).toBe("true");
    expect(env.PAPERCLIP_WORKTREE_NAME).toBeUndefined();
    expect(env.PAPERCLIP_HOME).toBe("/tmp/worktree-paperclip-home");
    expect(env.PAPERCLIP_CONFIG).toBe("/tmp/worktree-paperclip-home/config.json");
    expect(env.PAPERCLIP_INSTANCE_ID).toBe("sup-137-sanitize-worktree-env");
    expect(env.PAPERCLIP_CONTEXT).toBeUndefined();
  });
});
