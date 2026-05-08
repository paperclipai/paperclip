// Direct invocation of the upload route handler — exercises the multipart
// scan path without spinning up Next.js or hitting Paperclip.
import { POST } from "../app/api/upload/route";

process.env.PAPERCLIP_API_URL = process.env.PAPERCLIP_API_URL ?? "http://127.0.0.1:1";
process.env.PAPERCLIP_API_KEY = process.env.PAPERCLIP_API_KEY ?? "test-key";
process.env.PAPERCLIP_COMPANY_ID = process.env.PAPERCLIP_COMPANY_ID ?? "test-company";

async function call(form: FormData): Promise<{ status: number; body: any }> {
  const req = new Request("http://localhost/api/upload", { method: "POST", body: form });
  const res = await POST(req);
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* keep text */
  }
  return { status: res.status, body };
}

function expectEq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"} ${label}`);
  if (!ok) {
    console.log("  got:", JSON.stringify(got));
    console.log("  want:", JSON.stringify(want));
    process.exitCode = 1;
  }
}

function buildForm(filename: string, content = "fake-bytes"): FormData {
  const form = new FormData();
  form.append("issueId", "GLA-987");
  form.append("file", new Blob([content], { type: "image/jpeg" }), filename);
  return form;
}

async function main() {
  const shutter = await call(buildForm("shutterstock_123456.jpg"));
  expectEq("shutterstock returns 400", shutter.status, 400);
  expectEq("shutterstock body.error", shutter.body.error, "forbidden-source");
  expectEq("shutterstock body.source", shutter.body.source, "shutterstock");

  const adobe = await call(buildForm("AdobeStock_98765.png"));
  expectEq("adobestock returns 400", adobe.status, 400);
  expectEq("adobestock body.source", adobe.body.source, "adobe-stock");

  const getty = await call(buildForm("GettyImages-99999_final.jpg"));
  expectEq("getty returns 400", getty.status, 400);
  expectEq("getty body.source", getty.body.source, "getty");

  // Clean filename — proxy step will fail (502) since upstream is bogus, but it
  // should NOT be 400 with forbidden-source.
  const clean = await call(buildForm("local-flux-output.png"));
  const isForbidden =
    clean.status === 400 && (clean.body as any)?.error === "forbidden-source";
  expectEq("clean filename does not return forbidden-source", isForbidden, false);
}

main();
