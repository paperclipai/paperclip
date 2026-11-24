import { lstatSync } from "node:fs";
import { join } from "node:path";

/**
 * Join `home/.paperclip/runtimes/<route>/<target>/<closure>`, refusing any
 * existing component that is a link or not a directory. Setup refuses the same
 * components, so an installation is always resolvable at launch.
 */
export function realRuntimeCachePath(home: string, route: string, target: string, closure: string, message: string): string {
  let directory = home;
  for (const part of [".paperclip", "runtimes", route, target, closure]) {
    directory = join(directory, part);
    try {
      const stat = lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(message);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return directory;
}
