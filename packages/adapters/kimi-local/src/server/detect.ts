export async function detectModel(): Promise<{
  model: string;
  provider: string;
  source: string;
  candidates?: string[];
} | null> {
  return {
    model: "kimi-k2.6",
    provider: "kimi",
    source: "default",
    candidates: ["kimi-k2.6", "kimi-k2.5"],
  };
}
