import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listHermesProfileSkills, syncHermesProfileSkills } from "./skills.js";

const homedirSpy = vi.spyOn(os, "homedir");

afterEach(() => {
  homedirSpy.mockRestore();
});

describe("hermes_profile skills sync", () => {
  it("does not emit read-only warnings for list or sync snapshots", async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-profile-skills-"));
    homedirSpy.mockReturnValue(tmpRoot);

    await fs.mkdir(path.join(tmpRoot, ".hermes", "profiles", "stella", "skills", "creative", "humanizer"), { recursive: true });
    await fs.writeFile(
      path.join(tmpRoot, ".hermes", "profiles", "stella", "skills", "creative", "humanizer", "SKILL.md"),
      "# humanizer\n",
    );

    const ctx = {
      config: { profile: "stella" },
      agent: { id: "agent-1", companyId: "company-1", name: "Stella", adapterType: "hermes_profile", adapterConfig: {} },
      context: {},
      runId: "run-1",
      runtime: { sessionParams: null, sessionId: "session-1", sessionDisplayId: null, taskKey: null },
      onLog: async () => {},
    } as any;

    const listed = await listHermesProfileSkills(ctx);
    const synced = await syncHermesProfileSkills(ctx, ["hermes-profile/creative/humanizer"]);

    expect(listed.warnings).toEqual([]);
    expect(synced.warnings).toEqual([]);
    expect(listed.entries).toContainEqual(expect.objectContaining({ key: "hermes-profile/creative/humanizer" }));
    expect(synced.desiredSkills).toEqual(["hermes-profile/creative/humanizer"]);
  });
});
