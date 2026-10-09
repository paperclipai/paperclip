import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, link, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { NativeRuntimeContextSnapshot } from "../../contracts/runtime-context.js";
import { stageHermesAgentState } from "./hermes-state.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "hermes-state-test-")); roots.push(root);
  const agent = join(root, "agent"), home = join(root, "home");
  await mkdir(agent); await mkdir(home);
  const context = { instructions: { workingCopy: { kind: "agent_files", rootPath: agent, entryPath: "AGENTS.md" } }, skills: [], mcp: {} } as unknown as NativeRuntimeContextSnapshot;
  return { root, agent, home, context };
}
describe("Hermes managed learned state", () => {
  it("persists memory and learned skill edits into a fresh task without credentials or session history", async () => {
    const f = await fixture();
    const state = await stageHermesAgentState(f.home, f.context);
    await writeFile(join(f.home, "memories/MEMORY.md"), "Remember project conventions.");
    await mkdir(join(f.home, "skills/learned"));
    await writeFile(join(f.home, "skills/learned/SKILL.md"), "Learned workflow.");
    await writeFile(join(f.home, "auth.json"), "credential-canary");
    await writeFile(join(f.home, "state.db"), "native-session-canary");
    await state.collect();
    const next = join(f.root, "next-task"); await mkdir(next);
    const nextState = await stageHermesAgentState(next, f.context);
    expect(await readFile(join(next, "memories/MEMORY.md"), "utf8")).toBe("Remember project conventions.");
    expect(await readFile(join(next, "skills/learned/SKILL.md"), "utf8")).toBe("Learned workflow.");
    for (const name of ["auth.json", "state.db"]) await expect(readFile(join(f.agent, "hermes", name))).rejects.toMatchObject({ code: "ENOENT" });
    await rm(join(next, "skills/learned/SKILL.md"));
    await nextState.collect();
    await expect(readFile(join(f.agent, "hermes/skills/learned/SKILL.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.each(["symlink", "hardlink"])("rejects a %s before collecting native files", async kind => {
    const f = await fixture();
    const state = await stageHermesAgentState(f.home, f.context);
    const secret = join(f.root, "secret"); await writeFile(secret, "credential-canary");
    const target = join(f.home, "memories/unsafe");
    if (kind === "symlink") await symlink(secret, target); else await link(secret, target);
    await expect(state.collect()).rejects.toThrow(/bounded regular files/);
    await expect(readFile(join(f.agent, "hermes/memories/unsafe"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("requires managed agent storage", async () => {
    const f = await fixture();
    await expect(stageHermesAgentState(f.home, null)).rejects.toThrow(/managed agent-file storage/);
  });
  it.each(["symlink", "replacement"])("rejects a %s state parent without changing the redirected files", async kind => {
    const f = await fixture();
    const state = await stageHermesAgentState(f.home, f.context);
    const outside = join(f.root, "outside");
    await mkdir(outside); await mkdir(join(outside, "memories")); await mkdir(join(outside, "skills"));
    await writeFile(join(outside, "memories/MEMORY.md"), "Outside memory");
    await writeFile(join(outside, "memories/keep.md"), "Must not be deleted");
    await writeFile(join(f.home, "memories/MEMORY.md"), "Native change");
    await rename(join(f.agent, "hermes"), join(f.agent, "original-hermes"));
    if (kind === "symlink") await symlink(outside, join(f.agent, "hermes"));
    else await rename(outside, join(f.agent, "hermes"));
    await expect(state.collect()).rejects.toThrow(/unsafe directory|identity changed/);
    const redirected = kind === "symlink" ? outside : join(f.agent, "hermes");
    expect(await readFile(join(redirected, "memories/MEMORY.md"), "utf8")).toBe("Outside memory");
    expect(await readFile(join(redirected, "memories/keep.md"), "utf8")).toBe("Must not be deleted");
  });
  it("discards unfinished transfers during staging and collection without learning their contents", async () => {
    const f = await fixture();
    const state = await stageHermesAgentState(f.home, f.context);
    const leftover = ".paperclip-hermes-transfer-00000000-0000-4000-8000-000000000001.tmp";
    await writeFile(join(f.home, "memories/MEMORY.md"), "Complete memory");
    await writeFile(join(f.home, "memories", leftover), "Incomplete memory");
    await writeFile(join(f.agent, "hermes/memories/MEMORY.md.paperclip-state.tmp"), "Old incomplete transfer");
    await state.collect();
    expect(await readdir(join(f.agent, "hermes/memories"))).toEqual(["MEMORY.md"]);
    expect(await readFile(join(f.agent, "hermes/memories/MEMORY.md"), "utf8")).toBe("Complete memory");
    await writeFile(join(f.agent, "hermes/memories", leftover), "Incomplete saved transfer");
    await stageHermesAgentState(f.home, f.context);
    expect(await readdir(join(f.home, "memories"))).toEqual(["MEMORY.md"]);
    expect(await readdir(join(f.agent, "hermes/memories"))).toEqual(["MEMORY.md"]);
  });
});
