import { deriveAuthCookiePrefix } from "../../auth/better-auth.js";
import { describe, expect, it, vi } from "vitest";
import { runtimeServiceEndpointSchema } from "@paperclipai/shared";
import { previewPath, runtimeServicePreviewConfig } from "./preview-config.js";
import { PREVIEW_COOKIE } from "./preview-access.js";
import { previewProxyRequestHeaders, previewProxyResponseHeaders, previewProxySocket } from "./preview-proxy.js";

describe("preview browser and upstream boundaries", () => {
  it("uses the cloud stack identity instead of a shared default local instance name", () => {
    vi.stubEnv("PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN", "test-only");
    try {
      vi.stubEnv("PAPERCLIP_CLOUD_STACK_ID", "");
      expect(() => runtimeServicePreviewConfig("https://github.io", false)).toThrow("PAPERCLIP_CLOUD_STACK_ID");
      vi.stubEnv("PAPERCLIP_CLOUD_STACK_ID", "stack-a");
      const a = runtimeServicePreviewConfig("https://github.io", false)!;
      vi.stubEnv("PAPERCLIP_CLOUD_STACK_ID", "stack-b");
      const b = runtimeServicePreviewConfig("https://github.io", false)!;
      const id = "d98d0ef3-c635-481a-8629-a8f438bdad2e";
      expect(a.origin(id, "web")).not.toBe(b.origin(id, "web"));
      expect(b.match(new URL(a.origin(id, "web")).host)).toBeNull();
    } finally { vi.unstubAllEnvs(); }
  });
  it("requires a separate registrable domain for each hosted endpoint", () => {
    for (const base of ["https://previews.example.com", "http://github.io", "https://github.io/path", "https://user@github.io", "http://localhost"]) {
      expect(() => runtimeServicePreviewConfig(base, false)).toThrow();
    }
    const config = runtimeServicePreviewConfig("https://github.io", false)!;
    const id = "d98d0ef3-c635-481a-8629-a8f438bdad2e";
    const host = new URL(config.origin(id, "web")).host;
    expect(config.match(host)?.serviceId).toBe(id);
    expect(config.origin(id, "api")).not.toBe(config.origin(id, "web"));
    expect(config.match(`${host}.evil.example`)).toBeNull();
    expect(config.match(host.toUpperCase())).toBeNull();
    expect(config.match(host.replace(".github.io", ".other.github.io"))).toBeNull();
  });
  it("keeps return paths and health probes on the selected origin", () => {
    for (const path of ["//other.example", "/\\other.example", "/\n/other.example", "https://other.example", "/.paperclip/handoff?ticket=bad"]) expect(previewPath(path)).toBe("/");
    expect(previewPath("/nested/../page?query=1#anchor")).toBe("/page?query=1#anchor");
    for (const healthPath of ["/\\other.example", "/\t/other.example", "/#hash", "//other.example"]) expect(runtimeServiceEndpointSchema.safeParse({ name: "web", healthPath }).success).toBe(false);
  });
  it("strips control-plane credentials and untrusted forwarding headers while preserving app authorization", () => {
    const headers = previewProxyRequestHeaders({ host: "forged", cookie: `${PREVIEW_COOKIE} =private; __Host-Http-${deriveAuthCookiePrefix()}.session_token=board; __Secure-${deriveAuthCookiePrefix()}.session_data.0=board; app_session=app; better-auth.session_token=app; paperclip-theme=dark`, authorization: "Bearer app-owned", "x-paperclip-cloud-token": "secret", "x-daytona-preview-token": "forged", "x-forwarded-host": "forged", connection: "X-Remove-Me", "x-remove-me": "private" },
      { url: "https://upstream.example", headers: { "x-daytona-preview-token": "provider-only" } }, "https://preview.example");
    expect(headers).toMatchObject({ host: "upstream.example", cookie: "app_session=app; better-auth.session_token=app; paperclip-theme=dark", authorization: "Bearer app-owned", "x-forwarded-host": "preview.example", "x-daytona-preview-token": "provider-only" });
    expect(headers).not.toHaveProperty("x-paperclip-cloud-token");
    expect(headers).not.toHaveProperty("x-remove-me");
  });
  it("protects preview cookies and app CSP, and rewrites only same-upstream redirects", () => {
    const headers = previewProxyResponseHeaders({
      "set-cookie": [`${PREVIEW_COOKIE} =attack; Secure; HttpOnly; Path=/`, "app=value; Domain = example.com; Path=/; HttpOnly", `__Secure-${deriveAuthCookiePrefix()}.session_token=forged; Secure`, "better-auth.session_token=app; Path=/"],
      "content-security-policy": "script-src 'self' 'unsafe-inline'; connect-src 'none'", "x-daytona-preview-token": "secret", location: "/login?next=%2F", "clear-site-data": '"*"',
    }, "https://upstream.example", "https://preview.example");
    expect(headers["set-cookie"]).toEqual(["app=value; Path=/; HttpOnly", "better-auth.session_token=app; Path=/"]);
    expect(headers["content-security-policy"]).toBe("script-src 'self' 'unsafe-inline'; connect-src 'none'");
    expect(headers.location).toBe("https://preview.example/login?next=%2F");
    expect(headers).not.toHaveProperty("x-daytona-preview-token");
    expect(headers).not.toHaveProperty("clear-site-data");
    expect(previewProxyResponseHeaders({ location: "https://app-login.example/" }, "https://upstream.example", "https://preview.example").location).toBe("https://app-login.example/");
  });
  it("rejects private, privileged and credential-bearing upstream substitutions before connecting", async () => {
    for (const [provider, url] of [["local", "http://127.0.0.1:22"], ["local", "http://169.254.169.254:1234"], ["local", "http://127.0.0.1:8080?token=bad"], ["daytona", "http://example.com"], ["daytona", "https://127.0.0.1:8080"], ["daytona", "https://user:secret@example.com"]]) {
      await expect(previewProxySocket({ url: url!, headers: {} }, provider!)).rejects.toThrow();
    }
  });
});
