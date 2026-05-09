import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RejectBody = {
  note?: string;
  docKey?: string;
};

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

  let body: RejectBody;
  try {
    body = (await req.json()) as RejectBody;
  } catch {
    body = {};
  }
  const note = (body.note ?? "").trim();
  const docKey = body.docKey ?? "";
  if (!note) {
    return NextResponse.json({ error: "missing_note" }, { status: 400 });
  }
  if (note.length > 4000) {
    return NextResponse.json({ error: "note_too_long" }, { status: 400 });
  }

  const commentBody = `## ❌ Rejected — change requested

${note}${docKey ? `

- Asset: \`${docKey}\`` : ""}`;

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
      body: JSON.stringify({ status: "in_progress" }),
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

  return NextResponse.json({ ok: true, status: "in_progress" });
}
