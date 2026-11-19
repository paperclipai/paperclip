import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { resolvePaperclipInstanceRoot } from "../../home-paths.js";
import { codexSkillHomeStoreRoot } from "./native-session-executor.js";

const original = process.env.PAPERCLIP_RUNNER_STATE_DIR;

afterEach(() => {
  if (original === undefined) delete process.env.PAPERCLIP_RUNNER_STATE_DIR;
  else process.env.PAPERCLIP_RUNNER_STATE_DIR = original;
});

describe("Codex skill home store root", () => {
  it("sits next to an overridden durable-sessions directory", () => {
    process.env.PAPERCLIP_RUNNER_STATE_DIR = resolve("/x/runtime/paperclip-runner/durable-sessions");
    expect(codexSkillHomeStoreRoot()).toBe(resolve("/x/runtime/paperclip-runner/skill-homes"));
  });

  it("defaults to the instance's paperclip-runner runtime directory", () => {
    delete process.env.PAPERCLIP_RUNNER_STATE_DIR;
    expect(codexSkillHomeStoreRoot()).toBe(
      join(resolvePaperclipInstanceRoot(), "runtime", "paperclip-runner", "skill-homes"),
    );
  });
});
