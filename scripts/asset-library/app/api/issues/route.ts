import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TITLE_PREFIX = "[review-and-ship]";

export async function GET() {
  const apiUrl = process.env.PAPERCLIP_API_URL;
  const apiKey = process.env.PAPERCLIP_API_KEY;
  const companyId = process.env.PAPERCLIP_COMPANY_ID;

  if (!apiUrl || !apiKey || !companyId) {
    return NextResponse.json(
      {
        error: "missing_paperclip_env",
        missing: [
          !apiUrl && "PAPERCLIP_API_URL",
          !apiKey && "PAPERCLIP_API_KEY",
          !companyId && "PAPERCLIP_COMPANY_ID",
        ].filter(Boolean),
      },
      { status: 500 },
    );
  }

  const upstream = `${apiUrl.replace(/\/$/, "")}/api/companies/${companyId}/issues?titlePrefix=${encodeURIComponent(TITLE_PREFIX)}`;

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
    const body = await res.text();
    return new NextResponse(body, {
      status: res.status,
      headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
    });
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    return NextResponse.json({ error: "upstream_invalid_json" }, { status: 502 });
  }

  // Defensive: upstream currently ignores `titlePrefix` so filter here.
  const issues = Array.isArray(payload) ? (payload as Array<{ title?: unknown }>) : [];
  const filtered = issues.filter(
    (i) => typeof i?.title === "string" && (i.title as string).startsWith(TITLE_PREFIX),
  );
  return NextResponse.json(filtered);
}
