import { Agent as HttpAgent, request as requestHttp } from "node:http";
import { Agent as HttpsAgent, request as requestHttps } from "node:https";
import { getCACertificates } from "node:tls";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

export const MODEL_CATALOG_MAX_BYTES = 2 * 1024 * 1024;

/** Unknown metadata must not turn into an assertion that images are unsupported. */
export function advertisedModelImageInput(catalog: unknown, model: string): boolean | undefined {
  if (!catalog || typeof catalog !== "object" || !("data" in catalog) || !Array.isArray(catalog.data)) return undefined;
  const matches = catalog.data.filter(entry => entry && typeof entry === "object" && entry.id === model);
  if (matches.length !== 1) return undefined;
  const entry = matches[0];
  if (typeof entry.capabilities?.vision === "boolean") return entry.capabilities.vision;
  if (Array.isArray(entry.input_modalities) && entry.input_modalities.length > 0 &&
      entry.input_modalities.every((value: unknown) => typeof value === "string")) {
    return entry.input_modalities.includes("image");
  }
  return undefined;
}

export function modelImageModalities(imageInput: boolean | undefined) {
  return imageInput === undefined ? {} : {
    modalities: { input: imageInput ? ["text", "image"] : ["text"], output: ["text"] },
  };
}

/** Only the selected endpoint is queried. Redirects must never receive its credential. */
export function modelCatalogUrl(baseUrl: string): URL {
  const url = new URL(`${baseUrl.replace(/\/+$/, "")}/models`);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Invalid model catalog endpoint");
  }
  return url;
}

/** Keep transport settings scoped to the executing runtime, including custom trust. */
export async function modelCatalogAgent(url: URL, environment: NodeJS.ProcessEnv) {
  const proxyEnv = {
    HTTP_PROXY: environment.http_proxy ?? environment.HTTP_PROXY ?? environment.all_proxy ?? environment.ALL_PROXY,
    HTTPS_PROXY: environment.https_proxy ?? environment.HTTPS_PROXY ?? environment.http_proxy ?? environment.HTTP_PROXY ?? environment.all_proxy ?? environment.ALL_PROXY,
    NO_PROXY: environment.no_proxy ?? environment.NO_PROXY,
  };
  if (url.protocol !== "https:") return new HttpAgent({ proxyEnv });
  const ca = [...getCACertificates("default")];
  if (environment.SSL_CERT_FILE) ca.push(await readFile(environment.SSL_CERT_FILE, "utf8"));
  if (environment.SSL_CERT_DIR) {
    for (const entry of await readdir(environment.SSL_CERT_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        const certificate = await readFile(join(environment.SSL_CERT_DIR, entry.name), "utf8");
        if (certificate.includes("-----BEGIN CERTIFICATE-----")) ca.push(certificate);
      }
    }
  }
  return new HttpsAgent({ proxyEnv, ca });
}

/** Call from the harness runtime, never from control-plane credential preparation. */
export async function discoverModelImageInput(input: {
  baseUrl: string; credential: string; model: string; environment: NodeJS.ProcessEnv;
}): Promise<boolean | undefined> {
  let agent: HttpAgent | HttpsAgent | undefined;
  try {
    const url = modelCatalogUrl(input.baseUrl);
    agent = await modelCatalogAgent(url, input.environment);
    const response = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
      const request = (url.protocol === "https:" ? requestHttps : requestHttp)(url, {
        agent,
        headers: input.credential ? { Authorization: `Bearer ${input.credential}` } : {},
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
      if (bytes > MODEL_CATALOG_MAX_BYTES) { response.destroy(); return undefined; }
      chunks.push(Buffer.from(chunk));
    }
    return advertisedModelImageInput(JSON.parse(Buffer.concat(chunks).toString("utf8")), input.model);
  } catch {
    // Optional discovery must not fail a text task or expose credentials in logs.
    return undefined;
  } finally {
    agent?.destroy();
  }
}
