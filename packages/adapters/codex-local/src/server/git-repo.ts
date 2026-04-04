import path from "node:path";
import { pathExists } from "./codex-home.js";

export async function isInsideGitRepo(candidate: string): Promise<boolean> {
  let current = path.resolve(candidate);

  while (true) {
    if (await pathExists(path.join(current, ".git"))) {
      return true;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return false;
    }
    current = parent;
  }
}
