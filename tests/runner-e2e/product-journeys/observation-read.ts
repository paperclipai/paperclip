import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { ConnectionFailure } from "../connection-config.js";
import type { ConnectionApi } from "../connection-target.js";
import { JourneyError } from "./types.js";

/** Retry only read transport failures within the original journey deadline.
 * Never replay user input, native work, or a mutating API call. */
export function createObservedReader(api: Pick<ConnectionApi, "get">, deadlineAt: number | (() => number)) {
  const deadline = () => typeof deadlineAt === "function" ? deadlineAt() : deadlineAt;
  const failures: Array<{ route: string; code: string }> = [];
  return {
    failures,
    async get<T = any>(route: string): Promise<T> {
      while (Date.now() < deadline()) {
        const remaining = deadline() - Date.now();
        if (remaining < 1) break;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const expired = new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new JourneyError("failed", "observation_read_deadline")), remaining);
          });
          const value = await Promise.race([api.get<T>(route, { timeoutMs: Math.min(30_000, remaining) }), expired]);
          if (Date.now() >= deadline()) throw new JourneyError("failed", "observation_read_deadline");
          return value;
        }
        catch (error) {
          if (!(error instanceof ConnectionFailure)) throw error;
          const code = error.message;
          if (code === "api_request_failed" || /^api_status_[1-5][0-9]{2}$/.test(code)) failures.push({ route, code });
          if (!(code === "api_request_failed" || /^api_status_(408|429|502|503|504)$/.test(code))) throw error;
          const remaining = deadline() - Date.now();
          if (remaining > 0) await new Promise(resolve => setTimeout(resolve, Math.min(1000, remaining)));
        }
        finally { clearTimeout(timer); }
      }
      throw new JourneyError("failed", "observation_read_deadline");
    },
    async preserve(directory: string) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(path.join(directory, "observation-read-failures.json"), JSON.stringify({ failures }, null, 2), { mode: 0o600 });
    },
  };
}
