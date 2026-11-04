import fs from "node:fs/promises";

export function createTranscriptProbe(
  inspect: (file: string) => Promise<boolean | null>,
  limit = 4,
  timeoutMs = 500,
): (file: string) => Promise<boolean | null> {
  const pending = new Map<string, Promise<boolean | null>>();
  return async (file) => {
    let operation = pending.get(file);
    if (!operation) {
      if (pending.size >= limit) return null;
      operation = Promise.resolve().then(() => inspect(file)).catch(() => null);
      pending.set(file, operation);
      void operation.finally(() => pending.delete(file));
    }
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}

export const probeTranscript = createTranscriptProbe(async (file) => {
  try {
    return (await fs.stat(file)).isFile();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? false : null;
  }
});
