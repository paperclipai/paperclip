import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { errorHandler } from "./middleware/error-handler.js";
import { HttpError } from "./errors.js";
import { oauthCallbackPage } from "./oauth-callback-page.js";

describe("OAuth callback pages", () => {
  it("escapes text and includes an accessible standalone fallback", () => {
    const html = oauthCallbackPage({ title: '<script>bad()</script>', description: 'A & B', actionHref: '/issues/a?x="', actionLabel: 'Return', state: 'success' });
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('name="viewport"');
    expect(html).toContain('&lt;script&gt;bad()&lt;/script&gt;');
    expect(html).toContain('href="/issues/a?x=&quot;"');
    expect(html).not.toContain('<script>bad()');
  });

  const paths = ["/api/tools/oauth/callback", "/api/tools/oauth/cloud-connector/callback", "/api/tools/oauth/paperclip-id/callback", "/api/tools/oauth/cloud-connector/enrollment-callback", "/api/tools/vercel-connect/callback", "/api/slack/search/callback", "/api/chat-github/manifest/callback"];
  function app(status = 400) {
    const app = express();
    app.use(() => { throw new HttpError(status, "API error"); });
    app.use(errorHandler);
    return app;
  }
  it.each(paths)("renders browser errors for %s without reflecting query data", async (path) => {
    const res = await request(app()).get(`${path}?state=private-state&error_description=private-message`).set('Accept', 'text/html');
    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.text).toContain('Return to Paperclip');
    expect(res.text).not.toContain('private-');
  });
  it("preserves JSON for API clients and unrelated endpoints", async () => {
    for (const [path, accept] of [[paths[0], 'application/json'], ['/api/companies', 'text/html']]) {
      expect((await request(app()).get(path).set('Accept', accept)).body).toEqual({ error: 'API error' });
    }
  });
  it.each([401, 403, 500])("preserves status %s and offers recovery", async (status) => {
    const res = await request(app(status)).get(paths[0]).set('Accept', 'text/html');
    expect(res.status).toBe(status);
    expect(res.text).toContain(status < 500 ? 'Sign in to finish connecting' : 'Something went wrong');
  });
});
