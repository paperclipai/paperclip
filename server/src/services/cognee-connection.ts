import { createHash } from "node:crypto";

/** Reviewed Cognee Cloud contract from cognee-mcp 0.5.5. Executed by the bundled bridge below. */
export const COGNEE_STDIO_TEMPLATE = {
  name: "Cognee Cloud",
  command: null,
  args: [] as string[],
  envKeys: ["COGNEE_BASE_URL", "COGNEE_API_KEY"],
  tools: [
    {
      name: "remember", description: "Store text in a Cognee dataset or session.",
      annotations: { readOnlyHint: false },
      inputSchema: { type: "object", properties: {
        data: { type: "string" }, dataset_name: { type: "string" },
        session_id: { type: "string" }, custom_prompt: { type: "string" },
      }, required: ["data"], additionalProperties: false },
    },
    {
      name: "recall", description: "Search Cognee memory, optionally within named datasets or a session.",
      annotations: { readOnlyHint: true },
      inputSchema: { type: "object", properties: {
        query: { type: "string" }, search_type: { type: "string" }, datasets: { type: "string" },
        session_id: { type: "string" }, system_prompt: { type: "string" }, top_k: { type: "integer", minimum: 1, default: 15 },
      }, required: ["query"], additionalProperties: false },
    },
    {
      name: "forget", description: "Permanently delete a Cognee dataset, or all owned memory when everything is true.",
      annotations: { destructiveHint: true },
      inputSchema: { type: "object", properties: {
        dataset: { type: "string" }, everything: { type: "boolean", default: false },
      }, additionalProperties: false },
    },
  ],
};

export function cogneeCloudUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || !/^[a-z0-9-]+\.aws\.cognee\.ai$/i.test(url.hostname)
    || url.port || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("Copy the tenant API Base URL from Cognee's API Keys page.");
  }
  return url;
}

/**
 * Bundled bridge for the three reviewed Cloud operations. No package manager,
 * subprocess, runtime downloads, or inherited host environment is involved.
 * The gateway supplies its DNS/redirect-guarded, response-bounded HTTP client.
 */
export async function callCogneeCloud(input: {
  baseUrl: string;
  apiKey: string;
  tool: string;
  parameters: Record<string, unknown>;
  request: (url: URL, init: RequestInit) => Promise<unknown>;
  signal: AbortSignal;
}) {
  const base = cogneeCloudUrl(input.baseUrl);
  if (!input.apiKey) throw new Error("Reconnect Cognee to restore its Cloud API key.");
  const tenant = /^tenant-([0-9a-f-]{36})\./i.exec(base.hostname)?.[1];
  const headers: Record<string, string> = { "X-Api-Key": input.apiKey };
  if (tenant) headers["X-Tenant-Id"] = tenant;
  const args = input.parameters;
  const post = async (path: string, body: Record<string, unknown> | FormData) => {
    const url = new URL(path, base);
    const request = new Request(url, { method: "POST",
      headers: body instanceof FormData ? headers : { ...headers, "Content-Type": "application/json" },
      body: body instanceof FormData ? body : JSON.stringify(body) });
    // The guarded client pins DNS through node:http and accepts byte buffers,
    // not fetch's FormData. Serialize with the matching multipart boundary.
    return input.request(url, { method: "POST", signal: input.signal,
      headers: Object.fromEntries(request.headers), body: Buffer.from(await request.arrayBuffer()), redirect: "manual" });
  };
  let result: unknown;
  if (input.tool === "remember") {
    const dataset = args.dataset_name || "paperclip_memory";
    if (args.session_id) {
      if (args.custom_prompt) throw new Error("custom_prompt is not supported with session_id in Cognee Cloud.");
      result = await post("/api/v1/remember/entry", {
        entry: { type: "qa", question: "", answer: args.data, context: "" },
        dataset_name: dataset, session_id: args.session_id,
      });
    } else {
      const form = new FormData();
      form.set("data", new Blob([String(args.data)], { type: "text/plain" }), `memory_${createHash("sha256").update(String(args.data)).digest("hex")}.txt`);
      form.set("datasetName", String(dataset));
      if (args.custom_prompt) form.set("custom_prompt", String(args.custom_prompt));
      result = await post("/api/v1/remember", form);
    }
  } else if (input.tool === "recall") {
    let datasets = typeof args.datasets === "string" ? args.datasets.split(",").map(v => v.trim()).filter(Boolean) : [];
    if (!datasets.length && !args.session_id) {
      const available = await input.request(new URL("/api/v1/datasets/", base), {
        method: "GET", headers, signal: input.signal, redirect: "manual",
      });
      if (!Array.isArray(available)) throw new Error("Cognee returned an invalid dataset list.");
      datasets = available.flatMap(value => value && typeof value.name === "string" ? [value.name] : []);
    }
    result = await post("/api/v1/recall", {
      query: args.query, top_k: args.top_k ?? 15,
      search_type: typeof args.search_type === "string" ? args.search_type.toUpperCase() : null,
      ...(datasets.length ? { datasets } : {}),
      ...(args.session_id ? { session_id: args.session_id } : {}),
      ...(args.system_prompt ? { system_prompt: args.system_prompt } : {}),
    });
  } else if (input.tool === "forget") {
    if (!args.dataset && args.everything !== true) throw new Error("Specify a dataset or set everything to true.");
    result = await post("/api/v1/forget", {
      everything: args.everything === true, ...(args.dataset ? { dataset: args.dataset } : {}),
    });
  } else {
    throw new Error("Unreviewed Cognee action.");
  }
  return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: { result }, isError: false };
}
