import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { RunnerApi } from "./api.js";
import { readRegisteredArtifacts } from "./registered-artifact.js";
import { evaluateMatcher } from "./matchers.js";

function fixture() {
  const bytes = Buffer.from("verified\n");
  const product = { id: "product", issueId: "issue", createdByRunId: "run", type: "artifact", status: "active", title: "proof.txt", metadata: { attachmentId: "attachment" } };
  const attachment = { id: "attachment", issueId: "issue", originatingRunId: "run", originalFilename: "proof.txt", contentType: "text/plain", byteSize: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  const download = vi.fn().mockResolvedValue({ ok: () => true, body: async () => bytes });
  const get = vi.fn().mockImplementation(async (path: string) => path.endsWith("work-products") ? [product] : [attachment]);
  return { product, attachment, download, get, api: { get, request: { get: download } } as unknown as RunnerApi };
}

it("downloads the exact registered run-attributed output through its public path", async () => {
  const { api, download } = fixture();
  const artifacts = await readRegisteredArtifacts(api, "issue", "run", ["proof.txt"]);
  expect(download).toHaveBeenCalledWith("/api/attachments/attachment/content?download=1");
  expect((await evaluateMatcher({ kind: "artifact_exact", name: "proof.txt", expected: "verified\n", mimeType: "text/plain" }, { artifacts })).passed).toBe(true);
});

it.each(["unregistered", "old-run", "unattributed", "hash-mismatch", "download-failure"])("refuses %s output evidence", async reason => {
  const { api, product, attachment, get, download } = fixture();
  if (reason === "unregistered") get.mockImplementation(async (path: string) => path.endsWith("work-products") ? [] : [attachment]);
  if (reason === "old-run") product.createdByRunId = "other-run";
  if (reason === "unattributed") attachment.originatingRunId = "other-run";
  if (reason === "hash-mismatch") attachment.sha256 = "incorrect";
  if (reason === "download-failure") download.mockResolvedValue({ ok: () => false, status: () => 404 });
  await expect(readRegisteredArtifacts(api, "issue", "run", ["proof.txt"])).rejects.toThrow();
});

it("does not accept a filename or unchecked content as downloaded evidence", async () => {
  const matcher = { kind: "artifact_exact" as const, name: "proof.txt", expected: "verified\n" };
  expect((await evaluateMatcher(matcher, { artifacts: [{ name: "proof.txt", content: "verified\n" }] })).passed).toBe(false);
  expect((await evaluateMatcher(matcher, { artifacts: [{ name: "proof.txt", contentVerified: true, content: "wrong" }] })).passed).toBe(false);
});
