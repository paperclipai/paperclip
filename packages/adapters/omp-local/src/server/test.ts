import { ensureCommandResolvable } from "@paperclipai/adapter-utils/server-utils";

export async function testEnvironment(config: Record<string, unknown> | null): Promise<{
  ok: boolean;
  error?: string;
}> {
  const command = (typeof config === "object" && config !== null && config.command) || "omp";
  try {
    await ensureCommandResolvable(command as string);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: `OMP command "${command}" is not installed or not in PATH. Install via: npm install -g omp`,
    };
  }
}
