import { GoogleToolError } from "../errors.js";

export const GMAIL_READ_CONCURRENCY = 10;

export async function mapLimited<T, R>(items: readonly T[], read: (item: T) => Promise<R>, limit = GMAIL_READ_CONCURRENCY): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const index = next++;
      try {
        results[index] = await read(items[index]!);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export async function unlessMissing<R>(read: Promise<R>): Promise<R | null> {
  try {
    return await read;
  } catch (error) {
    if (error instanceof GoogleToolError && error.kind === "not_found") return null;
    throw error;
  }
}
