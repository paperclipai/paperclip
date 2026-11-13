import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { pollUntil, RunnerApi } from "./api.js";
import { readRegisteredArtifacts, RegisteredArtifactNotFoundError } from "./registered-artifact.js";
import { evaluateMatcher } from "./matchers.js";

function fixture() {
  const bytes = Buffer.from("verified\n");
  const product = { id: "product", issueId: "issue", createdByRunId: "run", type: "artifact", status: "active", title: "proof.txt", metadata: { attachmentId: "4d6f7d24-bc94-42e5-9c47-26d18f212d8e" } };
  const attachment = { id: "4d6f7d24-bc94-42e5-9c47-26d18f212d8e", issueId: "issue", originatingRunId: "run", originalFilename: "proof.txt", contentType: "text/plain", byteSize: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  const download = vi.fn().mockResolvedValue(bytes);
  const get = vi.fn().mockImplementation(async (path: string) => path.endsWith("work-products") ? [product] : [attachment]);
  return { product, attachment, download, get, api: { get, getAttachmentContent: download, request: { get: () => { throw new Error("Unauthenticated transport forbidden"); } } } as unknown as RunnerApi };
}

it.each(["active", "ready_for_review", "approved"])("downloads the exact registered run-attributed %s output through its public path", async status => {
  const { api, product, download } = fixture();
  product.status = status;
  const artifacts = await readRegisteredArtifacts(api, "issue", "run", ["proof.txt"]);
  expect(download).toHaveBeenCalledWith("4d6f7d24-bc94-42e5-9c47-26d18f212d8e");
  expect((await evaluateMatcher({ kind: "artifact_exact", name: "proof.txt", expected: "verified\n", mimeType: "text/plain" }, { artifacts })).passed).toBe(true);
});

it.each(["draft", "changes_requested", "merged", "closed", "failed", "archived", "superseded", "withdrawn", "unknown"])("refuses %s artifact registrations before downloading", async status => {
  const { api, product, download } = fixture();
  product.status = status;
  await expect(readRegisteredArtifacts(api, "issue", "run", ["proof.txt"])).rejects.toThrow("Expected one registered artifact");
  expect(download).not.toHaveBeenCalled();
});

it.each(["unregistered", "duplicate", "old-run", "unattributed", "wrong-issue", "wrong-attachment-issue", "wrong-type", "wrong-filename", "wrong-attachment-id", "negative-size", "excessive-size", "size-mismatch", "hash-mismatch", "download-failure"])("refuses %s output evidence even when ready for review", async reason => {
  const { api, product, attachment, get, download } = fixture();
  product.status = "ready_for_review";
  if (reason === "unregistered") get.mockImplementation(async (path: string) => path.endsWith("work-products") ? [] : [attachment]);
  if (reason === "duplicate") get.mockImplementation(async (path: string) => path.endsWith("work-products") ? [product, { ...product, id: "duplicate", status: "approved" }] : [attachment]);
  if (reason === "old-run") product.createdByRunId = "other-run";
  if (reason === "unattributed") attachment.originatingRunId = "other-run";
  if (reason === "wrong-issue") product.issueId = "other-issue";
  if (reason === "wrong-attachment-issue") attachment.issueId = "other-issue";
  if (reason === "wrong-type") product.type = "document";
  if (reason === "wrong-filename") attachment.originalFilename = "other.txt";
  if (reason === "wrong-attachment-id") product.metadata.attachmentId = "other-attachment";
  if (reason === "negative-size") attachment.byteSize = -1;
  if (reason === "excessive-size") attachment.byteSize = 262_145;
  if (reason === "size-mismatch") attachment.byteSize += 1;
  if (reason === "hash-mismatch") attachment.sha256 = "incorrect";
  if (reason === "download-failure") download.mockRejectedValue(new Error("Authenticated download returned 404"));
  await expect(readRegisteredArtifacts(api, "issue", "run", ["proof.txt"])).rejects.toThrow();
});

it("identifies the deliverable by its run-attributed file, not its display title", async () => {
  const { api, product, attachment, download } = fixture();
  product.title = "Acorn Notes proof (proof.txt)";
  expect((await readRegisteredArtifacts(api, "issue", "run", ["proof.txt"]))[0]?.contentVerified).toBe(true);
  attachment.originalFilename = "other.txt";
  download.mockClear();
  await expect(readRegisteredArtifacts(api, "issue", "run", ["proof.txt"])).rejects.toBeInstanceOf(RegisteredArtifactNotFoundError);
  expect(download).not.toHaveBeenCalled();
});

it("does not accept a filename or unchecked content as downloaded evidence", async () => {
  const matcher = { kind: "artifact_exact" as const, name: "proof.txt", expected: "verified\n" };
  expect((await evaluateMatcher(matcher, { artifacts: [{ name: "proof.txt", content: "verified\n" }] })).passed).toBe(false);
  expect((await evaluateMatcher(matcher, { artifacts: [{ name: "proof.txt", contentVerified: true, content: "wrong" }] })).passed).toBe(false);
});

it("distinguishes a checkpoint not yet registered from corrupt or unauthorized evidence", async () => {
  const { api, product, attachment, get, download } = fixture();
  get.mockImplementation(async (path: string) => path.endsWith("work-products") ? [] : [attachment]);
  await expect(readRegisteredArtifacts(api, "issue", "run", ["proof.txt"])).rejects.toBeInstanceOf(RegisteredArtifactNotFoundError);
  expect(download).not.toHaveBeenCalled();
  get.mockImplementation(async (path: string) => path.endsWith("work-products") ? [product] : [attachment]);
  expect((await readRegisteredArtifacts(api, "issue", "run", ["proof.txt"]))[0]?.contentVerified).toBe(true);
  get.mockImplementation(async (path: string) => path.endsWith("work-products") ? [product, { ...product, id: "duplicate" }] : [attachment]);
  await expect(readRegisteredArtifacts(api, "issue", "run", ["proof.txt"])).rejects.not.toBeInstanceOf(RegisteredArtifactNotFoundError);
  get.mockImplementation(async (path: string) => path.endsWith("work-products") ? [product] : [attachment]);
  download.mockRejectedValue(new Error("Authenticated download returned 403"));
  await expect(readRegisteredArtifacts(api, "issue", "run", ["proof.txt"])).rejects.not.toBeInstanceOf(RegisteredArtifactNotFoundError);
  get.mockRejectedValue(new Error("read access revoked"));
  await expect(readRegisteredArtifacts(api, "issue", "run", ["proof.txt"])).rejects.toThrow("read access revoked");
});


it.each(["duplicate", "corrupt", "revoked"])("strict checkpoint polling retains a first %s observation instead of accepting a later replacement", async reason => {
  const { api, product, attachment, get, download } = fixture();
  let reads = 0;
  get.mockImplementation(async (path: string) => {
    if (!path.endsWith("work-products")) return [attachment];
    reads++;
    if (reads === 1 && reason === "revoked") throw new Error("read access revoked");
    return reads === 1 && reason === "duplicate" ? [product, { ...product, id: "duplicate" }] : [product];
  });
  if (reason === "corrupt") download.mockResolvedValueOnce(Buffer.from("bad bytes"));
  await expect(pollUntil({ label: "strict checkpoint", deadlineAt: Date.now() + 1000, intervalMs: 1,
    retryOnError: () => false,
    load: () => readRegisteredArtifacts(api, "issue", "run", ["proof.txt"]).catch(error => {
      if (error instanceof RegisteredArtifactNotFoundError) return [];
      throw error;
    }), accept: rows => rows.length === 1 })).rejects.toThrow();
  expect(reads).toBe(1);
});

it("uses the actual human-session authenticated transport for metadata and exact attachment bytes", async () => {
  const { product, attachment } = fixture(), bytes = Buffer.from("verified\n");
  vi.stubEnv("PAPERCLIP_RUNNER_E2E_PORT", "31991");
  const raw = vi.fn(() => { throw new Error("Raw request loses human session"); });
  const fetcher = vi.fn(async (url: URL | string, options: RequestInit) => {
    expect(options.headers).toMatchObject({ Cookie: "synthetic-owner-session", Origin: "http://127.0.0.1:31991" });
    const endpoint = new URL(url).pathname;
    if (endpoint.endsWith("work-products")) return Response.json([product]);
    if (endpoint.endsWith("attachments")) return Response.json([attachment]);
    expect(endpoint).toBe(`/api/attachments/${attachment.id}/content`);
    return new Response(bytes);
  });
  vi.stubGlobal("fetch", fetcher);
  try {
    const api = new RunnerApi({ get: raw } as unknown as ConstructorParameters<typeof RunnerApi>[0]);
    api.setBrowserSession("synthetic-owner-session");
    const [artifact] = await readRegisteredArtifacts(api, "issue", "run", ["proof.txt"]);
    expect(artifact).toMatchObject({ contentVerified: true, sha256: attachment.sha256, content: "verified\n" });
    expect(raw).not.toHaveBeenCalled(); expect(fetcher).toHaveBeenCalledTimes(3);
  } finally { vi.unstubAllGlobals(); vi.unstubAllEnvs(); }
});
