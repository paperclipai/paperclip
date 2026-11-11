import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NativeRuntimeContextSnapshot } from "../../contracts/runtime-context.js";
import { materializeNativeRuntimeSkills, releaseMaterializedNativeRuntimeSkills } from "../runtime-context-materializer.js";

/** Assigned assets live outside the protected credential/runtime tree. */
export async function createAcpxRuntimeSkillLease(context: NativeRuntimeContextSnapshot | null) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "paperclip-acpx-skills-")));
  const skills = join(root, "skills");
  const close = async () => {
    await releaseMaterializedNativeRuntimeSkills(skills);
    await rm(root, { recursive: true, force: true });
  };
  try {
    await materializeNativeRuntimeSkills(context, skills);
    return { readRoots: context?.skills.length ? [await realpath(skills)] : [], close };
  } catch (error) {
    await close();
    throw error;
  }
}
