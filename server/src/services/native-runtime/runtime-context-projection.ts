import { posix } from "node:path";
import { mapNativeRuntimeContextAssetRoots, type NativeRuntimeContextSnapshot } from "../../vendor/paperclip-runner/index.js";

/** Keep repository bytes at their final provider-owned destination on the guest:
 * transport them once, outside recursive discovery, and admit the same root for
 * explicit reads. Old saved contexts retain their original transport layout.
 */
export function projectNativeRuntimeContextForRunner(context: NativeRuntimeContextSnapshot, filesystemRoot: string): NativeRuntimeContextSnapshot {
  if (context.skills.some(skill => skill.repository)) {
    const repositories = new Set(context.skills.flatMap(skill => skill.repository ? [skill.repository.bundle.digest] : []));
    return mapNativeRuntimeContextAssetRoots(context, asset => repositories.has(asset.digest)
      ? posix.join(filesystemRoot, "codex-home", "repositories", asset.digest)
      : posix.join(filesystemRoot, "context", "bundles", asset.digest));
  }
  return { ...context, instructions: { ...context.instructions,
    bundle: { ...context.instructions.bundle, rootPath: posix.join(filesystemRoot, "context", "instructions") } },
    skills: context.skills.map((skill, index) => ({ ...skill,
      bundle: { ...skill.bundle, rootPath: posix.join(filesystemRoot, "context", "skills", `${index}-${skill.bundle.digest.slice(0, 12)}`) } })) };
}
