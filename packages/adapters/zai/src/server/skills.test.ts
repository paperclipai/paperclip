import { describe, it, expect } from "vitest";
import type { AdapterSkillContext } from "@paperclipai/adapter-utils";
import { listZaiSkills, syncZaiSkills } from "./skills.js";

function makeCtx(config: Record<string, unknown>): AdapterSkillContext {
  return {
    adapterType: "zai",
    agentId: "00000000-0000-0000-0000-000000000001",
    companyId: "00000000-0000-0000-0000-000000000002",
    config,
  };
}

describe("listZaiSkills / syncZaiSkills", () => {
  it("returns an ephemeral snapshot for the zai adapter type", async () => {
    const snap = await listZaiSkills(makeCtx({}));
    expect(snap.adapterType).toBe("zai");
    expect(snap.supported).toBe(true);
    expect(snap.mode).toBe("ephemeral");
    expect(Array.isArray(snap.entries)).toBe(true);
  });

  it("marks configured skills with state='configured' when they're in desiredSkills", async () => {
    const config: Record<string, unknown> = {
      paperclipRuntimeSkills: [
        {
          key: "paperclipai/paperclip/foo",
          runtimeName: "foo",
          source: "/tmp/zero",
          required: false,
        },
      ],
      paperclipSkillSync: {
        desiredSkills: ["paperclipai/paperclip/foo"],
      },
    };
    const snap = await listZaiSkills(makeCtx(config));
    const fooEntry = snap.entries.find((e) => e.key === "paperclipai/paperclip/foo");
    expect(fooEntry).toBeDefined();
    expect(fooEntry?.state).toBe("configured");
    expect(fooEntry?.desired).toBe(true);
  });

  it("syncZaiSkills returns the same snapshot shape (server persists desired list before this hook fires)", async () => {
    const config = {
      paperclipRuntimeSkills: [
        { key: "paperclipai/paperclip/foo", runtimeName: "foo", source: "/tmp/zero", required: false },
      ],
    };
    const snap = await syncZaiSkills(makeCtx(config), ["paperclipai/paperclip/foo"]);
    expect(snap.adapterType).toBe("zai");
    expect(snap.mode).toBe("ephemeral");
    expect(Array.isArray(snap.entries)).toBe(true);
  });

  it("flags missing desired skills with state='missing' + warning", async () => {
    const config = {
      paperclipRuntimeSkills: [],
      paperclipSkillSync: {
        desiredSkills: ["paperclipai/paperclip/does-not-exist"],
      },
    };
    const snap = await listZaiSkills(makeCtx(config));
    const missing = snap.entries.find((e) => e.key === "paperclipai/paperclip/does-not-exist");
    expect(missing?.state).toBe("missing");
    expect(snap.warnings.some((w) => w.includes("not available"))).toBe(true);
  });
});
