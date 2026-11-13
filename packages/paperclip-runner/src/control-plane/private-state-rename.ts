import { renameSync } from "node:fs";

const pause = new Int32Array(new SharedArrayBuffer(4));

export function renamePrivateStateFile(source: string, target: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(source, target);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (process.platform !== "win32" || attempt >= 9 || !["EPERM", "EACCES", "EBUSY"].includes(code ?? "")) throw error;
      // Preserve atomic publication and its synchronous authority fence. A
      // Windows reader may briefly deny replacement; wait at most 90ms total.
      Atomics.wait(pause, 0, 0, 10);
    }
  }
}
