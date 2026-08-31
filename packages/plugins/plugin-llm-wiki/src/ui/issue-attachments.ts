type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export type IngestSourceActionResult = {
  operation?: {
    issue?: {
      id?: unknown;
    } | null;
  } | null;
};

export function readIngestOperationIssueId(result: unknown): string {
  const issueId = (result as IngestSourceActionResult | null)?.operation?.issue?.id;
  if (typeof issueId === "string" && issueId.trim()) return issueId;
  throw new Error("Ingest operation did not return an issue id; the dropped file could not be attached.");
}

async function readUploadError(response: Response): Promise<string> {
  const body = await response.json().catch(() => null);
  if (body && typeof body === "object") {
    const error = (body as { error?: unknown; message?: unknown }).error;
    if (typeof error === "string" && error.trim()) return error;
    const message = (body as { error?: unknown; message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return `Attachment upload failed with HTTP ${response.status}.`;
}

export async function uploadIssueAttachmentFile(input: {
  companyId: string;
  issueId: string;
  file: File;
  fetchImpl?: FetchLike;
}): Promise<unknown> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const form = new FormData();
  form.append("file", input.file);
  const response = await fetchImpl(
    `/api/companies/${encodeURIComponent(input.companyId)}/issues/${encodeURIComponent(input.issueId)}/attachments`,
    {
      method: "POST",
      credentials: "include",
      body: form,
    },
  );
  if (!response.ok) {
    throw new Error(await readUploadError(response));
  }
  return response.json();
}
