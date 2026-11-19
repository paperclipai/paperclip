import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { ensureManagedProfileSkillInstructions } from "./managed-profile-instructions.js";

it("preserves an existing destination rule and rejects linked rules directories", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-profile-rule-safety-"));
  try {
    const managed = path.join(root, "managed");
    const rules = path.join(managed, "rules");
    await fs.mkdir(rules, { recursive: true });
    const file = path.join(rules, "paperclip-managed-profile.md");
    await fs.writeFile(file, "Existing rule");
    await ensureManagedProfileSkillInstructions(managed);
    expect(await fs.readFile(file, "utf8")).toBe("Existing rule");
    const linked = path.join(root, "linked");
    await fs.mkdir(linked);
    await fs.symlink(rules, path.join(linked, "rules"), process.platform === "win32" ? "junction" : "dir");
    await expect(ensureManagedProfileSkillInstructions(linked)).rejects.toThrow("symbolic link");
    expect(await fs.readFile(file, "utf8")).toBe("Existing rule");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
