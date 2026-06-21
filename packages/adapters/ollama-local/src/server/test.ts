import { testOllamaConnection } from "./execute.js";

export async function testEnvironment(config: Record<string, unknown>): Promise<{ success: boolean; error?: string }> {
  const host = typeof config.host === "string" ? config.host : "http://localhost:11434";
  return testOllamaConnection(host);
}
