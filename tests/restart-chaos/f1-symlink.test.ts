import { describe, expect, it } from "vitest";
import { parseCommand } from "./config.js";
import { WORKLOAD_TRIGGERS } from "./journeys.js";
import { planTasks } from "./scheduler.js";
import type { OracleArtifacts } from "./types.js";
import { f1LinkName, workloadDefinitions } from "./workloads.js";

const NONCE = "abc123de";
const LISTING = `lrwxrwxrwx 1 daytona daytona 10 Nov 11 01:30 hosts-link-${NONCE} -> /etc/hosts`;
const notes = (text: string) => ({ [`NOTES-${NONCE}.md`]: text });
const artifacts = (overrides: Partial<OracleArtifacts> = {}): OracleArtifacts => ({
  issueStatus: "done", documents: {}, agentComments: [], files: notes(`F1-${NONCE}\n${LISTING}\n`), commands: {},
  workspacePath: "/workspace/chaos", ...overrides,
}) as OracleArtifacts;

describe("F1: absolute symlink kept in the repository workspace", () => {
  const f1 = workloadDefinitions.F1;

  it("asks for the absolute link and the notes file in a repository workspace", () => {
    expect(f1.usesRepository).toBe(true);
    const text = f1.description(NONCE);
    expect(text).toContain(`ln -s /etc/hosts ${f1LinkName(NONCE)}`);
    expect(text).toContain(`NOTES-${NONCE}.md`);
    expect(f1.collect.files(NONCE)).toEqual([`NOTES-${NONCE}.md`]);
  });

  it("passes only when the task is done and its saved notes file is in the workspace", () => {
    expect(f1.grade(NONCE, artifacts()).verdict).toBe("pass");
    expect(f1.grade(NONCE, artifacts({ issueStatus: "blocked" })).verdict).toBe("fail");
    expect(f1.grade(NONCE, artifacts({ files: {} })).verdict).toBe("fail");
    expect(f1.grade(NONCE, artifacts({ workspacePath: null })).verdict).toBe("fail");
  });

  it("needs the agent's ls -l line proving the absolute link existed before the save-back", () => {
    expect(f1.description(NONCE)).toContain(`ls -l ${f1LinkName(NONCE)}`);
    // Skipped link: notes only.
    expect(f1.grade(NONCE, artifacts({ files: notes(`F1-${NONCE}\n`) })).verdict).toBe("fail");
    // A regular file of the same name, or a link elsewhere, is not the link under test.
    expect(f1.grade(NONCE, artifacts({ files: notes(`F1-${NONCE}\n-rw-r--r-- 1 d d 3 Nov 11 01:30 hosts-link-${NONCE}\n`) })).verdict).toBe("fail");
    expect(f1.grade(NONCE, artifacts({ files: notes(`F1-${NONCE}\n${LISTING.replace("/etc/hosts", "etc/hosts")}\n`) })).verdict).toBe("fail");
    expect(f1.grade(NONCE, artifacts({ files: notes(`F1-${NONCE}\n${LISTING.replace(NONCE, "ffffffff")}\n`) })).verdict).toBe("fail");
  });

  it("is opt-in, time-triggered, and plans with restart faults on Daytona", () => {
    expect(WORKLOAD_TRIGGERS.F1).toEqual(["time"]);
    const defaults = parseCommand(["--seed", "1"]);
    expect(defaults.mode === "wave" && defaults.options.workloads).not.toContain("F1");
    const parsed = parseCommand(["--env", "daytona", "--daytona-image", `ghcr.io/paperclipai/paperclip-daytona-runner@sha256:${"b".repeat(64)}`,
      "--workloads", "F1", "--faults", "K2,K15", "--adapters", "codex", "--tasks", "2", "--seed", "3"]);
    if (parsed.mode !== "wave") throw new Error("expected a wave");
    expect(planTasks(parsed.options).map(task => task.workload)).toEqual(["F1", "F1"]);
  });
});
