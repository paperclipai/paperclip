// Upload proxy with forbidden-source scan.
// Multipart receiver that runs the GLA-927 W2C forbidden-source detector
// before forwarding the file to Paperclip's attachment endpoint.
// extend list here — see lib/forbidden-source-scan.ts and GLA-927.

import { NextResponse } from "next/server";
import { scanUpload } from "@/lib/forbidden-source-scan";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
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

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "invalid_multipart" }, { status: 400 });
  }

  const file = form.get("file");
  const issueId = (form.get("issueId") ?? "").toString().trim();
  if (!issueId) {
    return NextResponse.json({ error: "missing_field", field: "issueId" }, { status: 400 });
  }
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "missing_field", field: "file" }, { status: 400 });
  }

  const filenameFromForm = (form.get("filename") ?? "").toString().trim();
  const contentDisposition = req.headers.get("content-disposition") ?? "";
  const cdMatch = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(contentDisposition);
  const filename = filenameFromForm || cdMatch?.[1] || file.name || "upload.bin";

  const buffer = Buffer.from(await file.arrayBuffer());
  const verdict = await scanUpload(filename, buffer);
  if (verdict.kind === "block") {
    return NextResponse.json(
      {
        error: "forbidden-source",
        source: verdict.source,
        reason: verdict.reason,
        pattern: verdict.pattern,
        detector: verdict.detector,
        filename,
      },
      { status: 400 },
    );
  }

  const upstream = `${apiUrl.replace(/\/$/, "")}/api/companies/${companyId}/issues/${encodeURIComponent(issueId)}/attachments`;
  const proxied = new FormData();
  proxied.append("file", new Blob([buffer], { type: file.type || "application/octet-stream" }), filename);

  let res: Response;
  try {
    res = await fetch(upstream, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: proxied,
    });
  } catch (err) {
    return NextResponse.json(
      { error: "upstream_fetch_failed", message: (err as Error).message },
      { status: 502 },
    );
  }

  const contentType = res.headers.get("content-type") ?? "application/json";
  const body = await res.text();
  return new NextResponse(body, { status: res.status, headers: { "content-type": contentType } });
}
