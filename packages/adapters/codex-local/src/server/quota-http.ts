import { Agent, request } from "node:https";

export class CodexQuotaRequestError extends Error {
  constructor(readonly kind: "network" | "rejected" | "unavailable", message: string) {
    super(message);
    this.name = "CodexQuotaRequestError";
  }
}

export async function fetchQuotaResponse(
  url: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
  timeoutMs = 8000,
): Promise<Response> {
  let agent: Agent | undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const proxy = process.env.https_proxy || process.env.HTTPS_PROXY;
    if (proxy && !["http:", "https:"].includes(new URL(proxy).protocol)) throw new Error("Unsupported HTTPS proxy protocol");
    agent = new Agent({ proxyEnv: process.env });
    return await new Promise<Response>((resolve, reject) => {
      const req = request(url, {
        agent,
        headers,
        signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
      }, (res) => {
        const status = res.statusCode ?? 502;
        const limit = status >= 200 && status < 300 ? 1024 * 1024 : 4000;
        const chunks: Buffer[] = [];
        let size = 0;
        const finish = () => resolve(new Response(
          [204, 205, 304].includes(status) ? null : Buffer.concat(chunks), { status },
        ));
        res.on("data", (chunk: Buffer) => {
          const remaining = limit - size;
          chunks.push(chunk.subarray(0, remaining));
          size += chunk.length;
          if (size > limit) {
            if (status >= 200 && status < 300) {
              reject(new CodexQuotaRequestError("unavailable", "OpenAI returned an oversized verification response."));
            } else {
              finish();
            }
            res.destroy();
          }
        });
        res.on("end", finish);
        res.on("error", reject);
        res.on("aborted", () => reject(new Error("Incomplete quota response")));
      });
      req.on("error", reject);
      req.end();
    });
  } catch (error) {
    if (error instanceof CodexQuotaRequestError) throw error;
    throw new CodexQuotaRequestError("network", "Could not reach OpenAI to verify the subscription. Check the server's network or proxy connection, then try Connect again.");
  } finally {
    clearTimeout(timer);
    agent?.destroy();
  }
}
