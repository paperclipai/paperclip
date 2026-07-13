import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ADAPTER_AGNOSTIC_KEYS } from "./constants.js";

const EXPECTED_ADAPTER_AGNOSTIC_KEYS = [
  "env",
  "promptTemplate",
  "instructionsFilePath",
  "cwd",
  "timeoutSec",
  "graceSec",
  "bootstrapPromptTemplate",
  "paperclipSkillSync",
] as const;

function readRepoFile(pathFromRoot: string) {
  return readFileSync(
    fileURLToPath(new URL(`../../../${pathFromRoot}`, import.meta.url)),
    "utf8",
  );
}

describe("adapter-agnostic config keys", () => {
  it("keeps the preserved adapter config keys explicit", () => {
    expect(ADAPTER_AGNOSTIC_KEYS).toEqual(EXPECTED_ADAPTER_AGNOSTIC_KEYS);
  });

  it("is imported by the server and UI instead of being re-declared", () => {
    const serverSource = readRepoFile("server/src/routes/agents.ts");
    const uiSource = readRepoFile("ui/src/lib/agent-config-patch.ts");

    expect(serverSource).toContain("ADAPTER_AGNOSTIC_KEYS");
    expect(serverSource).toContain("from \"@paperclipai/shared\"");
    expect(serverSource).not.toMatch(/const\s+ADAPTER_AGNOSTIC_KEYS\s*=/);

    expect(uiSource).toContain("ADAPTER_AGNOSTIC_KEYS");
    expect(uiSource).toContain("from \"@paperclipai/shared\"");
    expect(uiSource).not.toMatch(/const\s+ADAPTER_AGNOSTIC_KEYS\s*=/);
  });
});
