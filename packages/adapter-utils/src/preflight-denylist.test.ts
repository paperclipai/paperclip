import { describe, expect, it } from "vitest";
import {
  evaluatePreflightDenylist,
  formatPreflightRefusalComment,
  resolvePreflightDenylistPath,
  DEFAULT_PREFLIGHT_DENYLIST_PATH,
  type PreflightDenylistConfig,
} from "./preflight-denylist.js";

const CONFIG: PreflightDenylistConfig = {
  version: 1,
  deny_workspace_cwd_prefixes: [
    "D:/Projects-ruflo/hillary-app",
    "D:/Projects-ruflo/hillary-erp",
    "D:/Projects/cosmetics-platform",
  ],
  deny_path_globs: [
    "**/.env",
    "**/.env.*",
    "**/secrets/**",
    "**/credentials/**",
    "**/*.pem",
    "**/*.key",
    "**/*.pfx",
  ],
};

describe("evaluatePreflightDenylist — workspace cwd prefix rule", () => {
  it.each([
    ["D:/Projects-ruflo/hillary-app", "D:/Projects-ruflo/hillary-app"],
    ["D:/Projects-ruflo/hillary-app/", "D:/Projects-ruflo/hillary-app"],
    ["D:/Projects-ruflo/hillary-app/src/feature", "D:/Projects-ruflo/hillary-app"],
    ["D:\\Projects-ruflo\\hillary-app\\src", "D:/Projects-ruflo/hillary-app"],
    ["d:/projects-ruflo/HILLARY-app", "D:/Projects-ruflo/hillary-app"],
    ["D:/Projects-ruflo/hillary-erp/backend", "D:/Projects-ruflo/hillary-erp"],
    ["D:/Projects/cosmetics-platform/apps/web", "D:/Projects/cosmetics-platform"],
  ])("refuses workspaceCwd=%s against prefix=%s", (workspaceCwd, expectedPrefix) => {
    const result = evaluatePreflightDenylist({ workspaceCwd, specBody: "", config: CONFIG });
    expect(result.decision).toBe("refuse");
    if (result.decision === "refuse") {
      expect(result.ruleId).toBe("deny_workspace_cwd_prefix");
      expect(result.matchedRule).toBe(expectedPrefix);
      expect(result.evidence).toContain(workspaceCwd);
      expect(result.evidence).toContain(expectedPrefix);
    }
  });

  it("does not match sibling repos that share a prefix substring", () => {
    // 'hillary-app-fake-test' must not be denied by the 'hillary-app' rule.
    const result = evaluatePreflightDenylist({
      workspaceCwd: "D:/Projects-ruflo/hillary-app-fake-test/src",
      specBody: "",
      config: CONFIG,
    });
    expect(result.decision).toBe("pass");
  });

  it("passes when workspaceCwd is empty", () => {
    const result = evaluatePreflightDenylist({
      workspaceCwd: "",
      specBody: "do work in /tmp",
      config: CONFIG,
    });
    expect(result.decision).toBe("pass");
  });
});

describe("evaluatePreflightDenylist — spec body path glob rule", () => {
  it.each([
    ["please read **/.env file", "**/.env"],
    ["modify apps/api/.env.production", "**/.env.*"],
    ["the secret is in apps/web/.env.local", "**/.env.*"],
    ["check the file at config/secrets/db.json", "**/secrets/**"],
    ["see credentials/aws.json for the key", "**/credentials/**"],
    ["load certs/server.pem", "**/*.pem"],
    ["the key file id_rsa.key is here", "**/*.key"],
    ["import client.pfx into the keystore", "**/*.pfx"],
  ])("refuses spec=%s by rule=%s", (specBody, expectedRule) => {
    const result = evaluatePreflightDenylist({
      workspaceCwd: "D:/Projects/DevOps",
      specBody,
      config: CONFIG,
    });
    expect(result.decision).toBe("refuse");
    if (result.decision === "refuse") {
      expect(result.ruleId).toBe("deny_path_glob_in_spec");
      expect(result.matchedRule).toBe(expectedRule);
    }
  });

  it("does not false-positive on prose that mentions 'env' without a path", () => {
    const result = evaluatePreflightDenylist({
      workspaceCwd: "D:/Projects/DevOps",
      specBody: "configure the environment variable PATH in the build step",
      config: CONFIG,
    });
    expect(result.decision).toBe("pass");
  });

  it("does not false-positive on 'key' as a generic word", () => {
    const result = evaluatePreflightDenylist({
      workspaceCwd: "D:/Projects/DevOps",
      specBody: "the unique key of the cache map is the user id",
      config: CONFIG,
    });
    expect(result.decision).toBe("pass");
  });
});

describe("evaluatePreflightDenylist — control allow case", () => {
  it("passes a normal mechanical task in an allowed workspace", () => {
    const result = evaluatePreflightDenylist({
      workspaceCwd: "D:/Projects-ruflo/GregoryMill",
      specBody: "rename buildOrder() to assembleOrder() across packages/server/src",
      config: CONFIG,
    });
    expect(result.decision).toBe("pass");
  });

  it("passes when both inputs are empty", () => {
    const result = evaluatePreflightDenylist({
      workspaceCwd: "",
      specBody: "",
      config: CONFIG,
    });
    expect(result.decision).toBe("pass");
  });
});

describe("evaluatePreflightDenylist — rule precedence", () => {
  it("workspace prefix rule fires before path glob rule when both match", () => {
    const result = evaluatePreflightDenylist({
      workspaceCwd: "D:/Projects-ruflo/hillary-app",
      specBody: "rotate the credentials/api.key",
      config: CONFIG,
    });
    expect(result.decision).toBe("refuse");
    if (result.decision === "refuse") {
      expect(result.ruleId).toBe("deny_workspace_cwd_prefix");
    }
  });
});

describe("formatPreflightRefusalComment", () => {
  it("renders the ADR-0008 §2.3 refusal line", () => {
    const comment = formatPreflightRefusalComment({
      workerName: "KimiCoder",
      unblockOwner: "Frontend Lead",
      decision: {
        decision: "refuse",
        ruleId: "deny_workspace_cwd_prefix",
        matchedRule: "D:/Projects-ruflo/hillary-app",
        evidence:
          "executionWorkspace.workspaceCwd 'D:/Projects-ruflo/hillary-app' starts with denied prefix 'D:/Projects-ruflo/hillary-app'",
      },
    });
    expect(comment).toBe(
      "[KimiCoder] BLOCKED by ADR-0008 rule deny_workspace_cwd_prefix — executionWorkspace.workspaceCwd 'D:/Projects-ruflo/hillary-app' starts with denied prefix 'D:/Projects-ruflo/hillary-app'. Unblock owner: Frontend Lead.",
    );
  });
});

describe("resolvePreflightDenylistPath", () => {
  it("returns the env override when set", () => {
    expect(
      resolvePreflightDenylistPath({
        PAPERCLIP_WORKER_RESIDENCY_DENYLIST: "/etc/paperclip/denylist.json",
      } as NodeJS.ProcessEnv),
    ).toBe("/etc/paperclip/denylist.json");
  });

  it("falls back to the DevOps repo default when no override is set", () => {
    expect(resolvePreflightDenylistPath({} as NodeJS.ProcessEnv)).toBe(
      DEFAULT_PREFLIGHT_DENYLIST_PATH,
    );
  });

  it("ignores blank override", () => {
    expect(
      resolvePreflightDenylistPath({
        PAPERCLIP_WORKER_RESIDENCY_DENYLIST: "   ",
      } as NodeJS.ProcessEnv),
    ).toBe(DEFAULT_PREFLIGHT_DENYLIST_PATH);
  });
});
