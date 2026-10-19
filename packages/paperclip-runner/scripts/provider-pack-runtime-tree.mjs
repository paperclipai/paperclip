import { rmSync } from "node:fs";
import { join } from "node:path";

export function removeControllerArtifactsFromProviderPack(packRoot) {
  for (const directory of ["bin", "remote-provider-packs"]) {
    rmSync(join(packRoot, "dist", directory), { recursive: true, force: true });
  }
}
