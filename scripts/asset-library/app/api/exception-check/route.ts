import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TOOL_EXCEPTION_RE = /\[tool-exception\]/i;

export async function GET(req: Request) {
  const apiUrl = process.env.PAPERCLIP_API_URL;
  const apiKey = process.env.PAPERCLIP_API_KEY;
  if (!apiUrl || !apiKey) {
    return NextResponse.json(
      { error: "missing_paperclip_env" },
      { status: 500 },
    );
  }
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "missing_id" }, { status: 400 });
  }
  const upstream = `${apiUrl.replace(/\/$/, "")}/api/issues/${encodeURIComponent(id)}`;
  let res: Response;
  try {
    res = await fetch(upstream, {
      headers: { Authorization: `Bearer ${apiKey}` },
      cache: "no-store",
    });
  } catch (err) {
    return NextResponse.json(
      { error: "upstream_fetch_failed", message: (err as Error).message },
      { status: 502 },
    );
  }
  if (!res.ok) {
    return NextResponse.json(
      { identifier: id, status: null, title: null, valid: false, reason: `upstream_${res.status}` },
      { status: 200 },
    );
  }
  let payload: Record<string, unknown>;
  try {
    payload = (await res.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { identifier: id, status: null, title: null, valid: false, reason: "invalid_json" },
      { status: 200 },
    );
  }
  const identifier = (payload.identifier as string) ?? id;
  const status = (payload.status as string) ?? null;
  const title = (payload.title as string) ?? null;
  const titleHasMarker = title ? TOOL_EXCEPTION_RE.test(title) : false;
  const valid = status === "done" && titleHasMarker;
  let reason: string | undefined;
  if (!valid) {
    if (status !== "done") reason = `status_not_done:${status ?? "unknown"}`;
    else if (!titleHasMarker) reason = "title_missing_tool_exception";
  }
  return NextResponse.json({ identifier, status, title, valid, reason });
}
