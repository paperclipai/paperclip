import { chmod } from "node:fs/promises";
import { resolve } from "node:path";

if (process.platform !== "win32") {
  for (const file of process.argv.slice(2)) {
    await chmod(resolve(process.cwd(), file), 0o755);
  }
}
