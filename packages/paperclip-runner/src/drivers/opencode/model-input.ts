import { request as requestHttp, type Agent } from "node:http";
import { request as requestHttps } from "node:https";

// The runner is a standalone package. Keep discovery at this runtime boundary;
// it must not depend on server services or the legacy adapter package.
export async function discoverModelImageInput(
  url: URL, credential: string, model: string, agent: Agent,
): Promise<boolean | undefined> {
  try {
    const response = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
      const request = (url.protocol === "https:" ? requestHttps : requestHttp)(url, {
        agent,
        headers: credential ? { Authorization: `Bearer ${credential}` } : {},
        signal: AbortSignal.timeout(3_000),
      }, resolve);
      request.once("error", reject);
      request.end();
    });
    if (response.statusCode !== 200) { response.destroy(); return undefined; }
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of response) {
      bytes += chunk.length;
      if (bytes > 2 * 1024 * 1024) { response.destroy(); return undefined; }
      chunks.push(Buffer.from(chunk));
    }
    const catalog = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!Array.isArray(catalog?.data)) return undefined;
    const matches = catalog.data.filter((entry: unknown) => entry !== null && typeof entry === "object" &&
      "id" in entry && entry.id === model);
    if (matches.length !== 1) return undefined;
    const entry = matches[0];
    if (typeof entry.capabilities?.vision === "boolean") return entry.capabilities.vision;
    if (Array.isArray(entry.input_modalities) && entry.input_modalities.length > 0 &&
        entry.input_modalities.every((value: unknown) => typeof value === "string")) {
      return entry.input_modalities.includes("image");
    }
  } catch {
    // Metadata is optional. Do not fail a task or print provider credentials.
  }
  return undefined;
}
