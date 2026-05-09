import { NextResponse } from "next/server";
import {
  evaluateApprovalGate,
  parseProvenance,
  type ExceptionRef,
  type IssueDocument,
} from "@/lib/asset-type";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TOOL_EXCEPTION_RE = /\[tool-exception\]/i;

type ApproveBody = {
  docKey?: string;
};

async function fetchExceptionFromPaperclip(
  apiUrl: string,
  apiKey: string,
  identifier: string,
): Promise<ExceptionRef> {
  try {
    const res = await fetch(
      `${apiUrl.replace(/\/$/, "")}/api/issues/${encodeURIComponent(identifier)}`,
      { headers: { Authorization: `Bearer ${apiKey}` }, cache: "no-store" },
    );
    if (!res.ok) {
      return {
        identifier,
        status: null,
        title: null,
        valid: false,
        reason: `upstream_${res.status}`,
      };
    }
    const payload = (await res.json()) as Record<string, unknown>;
    const status = (payload.status as string) ?? null;
    const title = (payload.title as string) ?? null;
    const titleHasMarker = title ? TOOL_EXCEPTION_RE.test(title) : false;
    const valid = status === "done" && titleHasMarker;
    return { identifier, status, title, valid };
  } catch {
    return { identifier, status: null, title: null, valid: false, reason: "fetch_error" };
  }
}

export async function POST(
  req: Request,
  { params }: { params: { issueId: string } },
) {
  const apiUrl = process.env.PAPERCLIP_API_URL;
  const apiKey = process.env.PAPERCLIP_API_KEY;
  const runId = process.env.PAPERCLIP_RUN_ID ?? "";
  if (!apiUrl || !apiKey) {
    return NextResponse.json({ error: "missing_paperclip_env" }, { status: 500 });
  }

  let body: ApproveBody;
  try {
    body = (await req.json()) as ApproveBody;
  } catch {
    body = {};
  }
  const docKey = body.docKey ?? "";

  // Server-side gate evaluation — defence in depth, never trust the client.
  let doc: IssueDocument | null = null;
  if (docKey) {
    try {
      const r = await fetch(
        `${apiUrl.replace(/\/$/, "")}/api/issues/${encodeURIComponent(params.issueId)}/documents/${encodeURIComponent(docKey)}`,
        { headers: { Authorization: `Bearer ${apiKey}` }, cache: "no-store" },
      );
      if (r.ok) doc = (await r.json()) as IssueDocument;
    } catch {
      doc = null;
    }
  }

  if (!doc) {
    return NextResponse.json(
      { error: "doc_not_found", issueId: params.issueId, docKey },
      { status: 404 },
    );
  }

  const prov = parseProvenance(doc);
  const exceptionId = prov.raw["exception_issue_id"] ?? prov.raw["exception"] ?? null;
  let exception: ExceptionRef | null = null;
  if (exceptionId) {
    exception = await fetchExceptionFromPaperclip(apiUrl, apiKey, exceptionId);
  }
  const gate = evaluateApprovalGate(prov, docKey, exception);
  if (!gate.allowed) {
    return NextResponse.json(
      { error: "gate_blocked", gate, exception },
      { status: 422 },
    );
  }

  const ts = new Date().toISOString();
  const commentBody = `## ✅ Approved by founder via asset library — ${ts}

- Asset: \`${docKey}\`
- Provenance: \`${prov.kind}\`${prov.tool ? ` (\`${prov.tool}\`)` : ""}${exception ? `
- Cloud waiver: [${exception.identifier}](/GLA/issues/${exception.identifier})` : ""}`;

  const headersOut: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
  };
  if (runId) headersOut["X-Paperclip-Run-Id"] = runId;

  const commentRes = await fetch(
    `${apiUrl.replace(/\/$/, "")}/api/issues/${encodeURIComponent(params.issueId)}/comments`,
    {
      method: "POST",
      headers: headersOut,
      body: JSON.stringify({ body: commentBody }),
      cache: "no-store",
    },
  );
  if (!commentRes.ok) {
    const text = await commentRes.text();
    return NextResponse.json(
      { error: "comment_failed", upstreamStatus: commentRes.status, body: text },
      { status: 502 },
    );
  }

  const patchRes = await fetch(
    `${apiUrl.replace(/\/$/, "")}/api/issues/${encodeURIComponent(params.issueId)}`,
    {
      method: "PATCH",
      headers: headersOut,
      body: JSON.stringify({ status: "todo" }),
      cache: "no-store",
    },
  );
  if (!patchRes.ok) {
    const text = await patchRes.text();
    return NextResponse.json(
      {
        ok: false,
        error: "patch_failed",
        upstreamStatus: patchRes.status,
        body: text,
        commentPosted: true,
      },
      { status: 502 },
    );
  }

  return NextResponse.json({ ok: true, status: "todo", gate, exception });
}
