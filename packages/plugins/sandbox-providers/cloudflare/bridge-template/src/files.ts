import type { Sandbox as CloudflareSandbox } from "@cloudflare/sandbox";
import { resolveSandbox, toErrorResponse, toJsonResponse, type BridgeEnv } from "./sandboxes.js";

export const FILES_ROUTE = "/api/paperclip-sandbox/v1/files";

export function validateSandboxFilePath(value: string | null): string | null {
  if (!value || !value.startsWith("/") || value.includes("\0")) return null;
  if (value.split("/").some((segment) => segment === "..")) return null;
  return value;
}

function isMissingFileError(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : String(error);
  return name === "FileNotFoundError" || code === "FILE_NOT_FOUND" || /file not found|no such file/i.test(message);
}

function parentDirectory(filePath: string): string {
  const index = filePath.lastIndexOf("/");
  return index <= 0 ? "/" : filePath.slice(0, index);
}

async function readSandboxFile(sandbox: CloudflareSandbox, filePath: string): Promise<Response> {
  let file: { content: ReadableStream<Uint8Array>; size: number };
  try {
    file = await sandbox.readFile(filePath, { encoding: "none" });
  } catch (error) {
    if (isMissingFileError(error)) {
      return toErrorResponse(404, "file_not_found", `No sandbox file at ${filePath}.`);
    }
    throw error;
  }
  return new Response(file.content, {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      "X-File-Size": String(file.size),
    },
  });
}

async function writeSandboxFile(sandbox: CloudflareSandbox, filePath: string, request: Request): Promise<Response> {
  if (!request.body) {
    return toErrorResponse(400, "invalid_request", "A request body is required.");
  }
  await sandbox.mkdir(parentDirectory(filePath), { recursive: true });
  await sandbox.writeFile(filePath, request.body);
  return toJsonResponse({ ok: true, path: filePath });
}

export async function handleFileTransfer(request: Request, env: BridgeEnv, url: URL): Promise<Response> {
  if (request.method !== "GET" && request.method !== "PUT") {
    return toErrorResponse(405, "method_not_allowed", "Use GET to read a sandbox file or PUT to write one.");
  }
  const providerLeaseId = url.searchParams.get("providerLeaseId")?.trim() ?? "";
  const filePath = validateSandboxFilePath(url.searchParams.get("path"));
  if (!providerLeaseId || !filePath) {
    return toErrorResponse(
      400,
      "invalid_request",
      "providerLeaseId and an absolute path without '..' segments are required.",
    );
  }
  console.log(JSON.stringify({ route: "files", method: request.method, providerLeaseId, path: filePath }));
  const sandbox = await resolveSandbox(env, providerLeaseId, { normalizeId: true });
  return request.method === "GET"
    ? await readSandboxFile(sandbox, filePath)
    : await writeSandboxFile(sandbox, filePath, request);
}
