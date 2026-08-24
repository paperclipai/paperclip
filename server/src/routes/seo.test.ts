import express from "express";
import request from "supertest";
import { beforeAll, describe, expect, it, vi } from "vitest";

// ── Mock DB ──────────────────────────────────────────────────────────
// The seoRoutes function calls:
//   db.select({...}).from(companies).where(eq(...)).limit(10_000)
//   db.select({...}).from(issues).where(and(...)).limit(10_000)
//
// We build a minimal mock that returns the chainable Drizzle API.

function createMockDb(overrides?: {
  companies?: Array<{
    id: string;
    name: string;
    issuePrefix: string;
    updatedAt: Date;
  }>;
  issues?: Array<{
    id: string;
    identifier: string | null;
    title: string;
    companyId: string;
    updatedAt: Date;
  }>;
  throwOnIssues?: boolean;
}) {
  const mockCompanies = overrides?.companies ?? [];
  const mockIssues = overrides?.issues ?? [];
  const throwOnIssues = overrides?.throwOnIssues ?? false;

  // .limit() returns the final Promise
  const mockLimit = vi.fn().mockImplementation(() => {
    if (throwOnIssues) return Promise.reject(new Error("DB failure"));
    return Promise.resolve(mockIssues);
  });
  // Companies query uses a different mock for .limit() that returns companies
  const mockLimitCompanies = vi.fn().mockResolvedValue(mockCompanies);

  // .where() returns an object with .limit()
  const mockWhere = vi.fn().mockReturnValue({ limit: mockLimit });
  const mockWhereCompanies = vi.fn().mockReturnValue({ limit: mockLimitCompanies });

  // .from() returns an object with .where()
  const mockSelectFromIssues = vi.fn().mockReturnValue({
    where: mockWhere,
  });
  const mockSelectFromCompanies = vi.fn().mockReturnValue({
    where: mockWhereCompanies,
  });

  // db.select() — first call is for companies, second for issues
  let callCount = 0;
  const mockSelect = vi.fn().mockImplementation(() => {
    callCount++;
    return {
      from: callCount === 1 ? mockSelectFromCompanies : mockSelectFromIssues,
    };
  });

  const db = { select: mockSelect };

  return { db, mockSelect, mockSelectFromCompanies, mockSelectFromIssues, mockWhere, mockWhereCompanies, mockLimit, mockLimitCompanies };
}

async function createApp(dbMock: ReturnType<typeof createMockDb>) {
  const { seoRoutes } = await import("./seo.js");
  const app = express();
  app.use(seoRoutes(dbMock.db as any));
  return app;
}

// Super test binds to :: by default, so req.hostname is "[::1]"
const EXPECTED_HOST = "[::1]";

// ── Tests ────────────────────────────────────────────────────────────

// Warm the ESM module cache so the first test doesn't time out on tsx transform
let warmedApp: express.Express;
beforeAll(async () => {
  const dbMock = createMockDb();
  warmedApp = await createApp(dbMock);
}, 30000);

describe("GET /robots.txt", () => {
  it("returns 200 with text/plain content type", async () => {
    const res = await request(warmedApp).get("/robots.txt");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/plain/);
  });

  it("includes the correct directives", async () => {
    const dbMock = createMockDb();
    const app = await createApp(dbMock);

    const res = await request(app).get("/robots.txt");
    const body = res.text;

    expect(body).toContain("User-agent: *");
    expect(body).toContain("Allow: /");
    expect(body).toContain("Disallow: /api/");
  }, 15000);

  it("includes the sitemap URL", async () => {
    const dbMock = createMockDb();
    const app = await createApp(dbMock);

    const res = await request(app).get("/robots.txt");
    const body = res.text;

    // Hostname depends on supertest binding; just verify it contains the sitemap path
    expect(body).toMatch(/Sitemap: https:\/\/.+\/sitemap\.xml/);
  }, 15000);

  it("sets Cache-Control: public, max-age=3600", async () => {
    const dbMock = createMockDb();
    const app = await createApp(dbMock);

    const res = await request(app).get("/robots.txt");

    expect(res.headers["cache-control"]).toMatch(/public/);
    expect(res.headers["cache-control"]).toMatch(/max-age=3600/);
  }, 15000);

  it("resolves X-Forwarded-Host when present", async () => {
    const dbMock = createMockDb();
    const app = await createApp(dbMock);

    const res = await request(app)
      .get("/robots.txt")
      .set("X-Forwarded-Host", "example.com");

    expect(res.text).toContain("Sitemap: https://example.com/sitemap.xml");
  }, 15000);

  it("uses the first entry of a comma-separated X-Forwarded-Host", async () => {
    const dbMock = createMockDb();
    const app = await createApp(dbMock);

    const res = await request(app)
      .get("/robots.txt")
      .set("X-Forwarded-Host", "primary.com, secondary.com");

    expect(res.text).toContain("Sitemap: https://primary.com/sitemap.xml");
  }, 15000);

  it("contains the robots.txt comment", async () => {
    const dbMock = createMockDb();
    const app = await createApp(dbMock);

    const res = await request(app).get("/robots.txt");

    expect(res.text).toContain("robots.txt for Paperclip");
  }, 15000);
});

describe("GET /sitemap.xml", () => {
  it("returns 200 with application/xml content type", async () => {
    const dbMock = createMockDb({
      companies: [
        { id: "c1", name: "TestCo", issuePrefix: "TST", updatedAt: new Date("2025-06-01") },
      ],
      issues: [],
    });
    const app = await createApp(dbMock);

    const res = await request(app).get("/sitemap.xml");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/xml/);
  }, 15000);

  it("returns valid XML with XML declaration and urlset", async () => {
    const dbMock = createMockDb({
      companies: [],
      issues: [],
    });
    const app = await createApp(dbMock);

    const res = await request(app).get("/sitemap.xml");
    const body = res.text;

    expect(body).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(body).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(body).toContain("</urlset>");
  }, 15000);

  it("includes static pages (/, /pricing)", async () => {
    const dbMock = createMockDb({
      companies: [],
      issues: [],
    });
    const app = await createApp(dbMock);

    const res = await request(app).get("/sitemap.xml");
    const body = res.text;

    expect(body).toContain(`<loc>https://${EXPECTED_HOST}/</loc>`);
    expect(body).toContain(`<loc>https://${EXPECTED_HOST}/pricing</loc>`);
  }, 15000);

  it("includes company dashboard and issues pages for each active company", async () => {
    const dbMock = createMockDb({
      companies: [
        { id: "c1", name: "Alpha", issuePrefix: "ALPHA", updatedAt: new Date("2025-06-01") },
        { id: "c2", name: "Beta", issuePrefix: "BETA", updatedAt: new Date("2025-06-15") },
      ],
      issues: [],
    });
    const app = await createApp(dbMock);

    const res = await request(app).get("/sitemap.xml");
    const body = res.text;

    expect(body).toContain(`<loc>https://${EXPECTED_HOST}/ALPHA/dashboard</loc>`);
    expect(body).toContain(`<loc>https://${EXPECTED_HOST}/ALPHA/issues</loc>`);
    expect(body).toContain(`<loc>https://${EXPECTED_HOST}/BETA/dashboard</loc>`);
    expect(body).toContain(`<loc>https://${EXPECTED_HOST}/BETA/issues</loc>`);
  }, 15000);

  it("includes issue detail pages for public issues", async () => {
    const dbMock = createMockDb({
      companies: [
        { id: "c1", name: "Alpha", issuePrefix: "ALPHA", updatedAt: new Date("2025-06-01") },
      ],
      issues: [
        {
          id: "i1",
          identifier: "ISSUE-1",
          title: "First issue",
          companyId: "c1",
          updatedAt: new Date("2025-06-10"),
        },
        {
          id: "i2",
          identifier: "ISSUE-2",
          title: "Second issue",
          companyId: "c1",
          updatedAt: new Date("2025-06-12"),
        },
      ],
    });
    const app = await createApp(dbMock);

    const res = await request(app).get("/sitemap.xml");
    const body = res.text;

    expect(body).toContain(`<loc>https://${EXPECTED_HOST}/ALPHA/issues/ISSUE-1</loc>`);
    expect(body).toContain(`<loc>https://${EXPECTED_HOST}/ALPHA/issues/ISSUE-2</loc>`);
  }, 15000);

  it("skips orphaned issues whose company is not in the active list", async () => {
    const dbMock = createMockDb({
      companies: [], // no active companies
      issues: [
        {
          id: "i1",
          identifier: "ORPHAN-1",
          title: "Orphan",
          companyId: "nonexistent",
          updatedAt: new Date("2025-06-10"),
        },
      ],
    });
    const app = await createApp(dbMock);

    const res = await request(app).get("/sitemap.xml");
    const body = res.text;

    // Orphaned issue should not appear
    expect(body).not.toContain("ORPHAN-1");
  }, 15000);

  it("sets Cache-Control: public, max-age=3600 on success", async () => {
    const dbMock = createMockDb({
      companies: [
        { id: "c1", name: "TestCo", issuePrefix: "TST", updatedAt: new Date("2025-06-01") },
      ],
      issues: [],
    });
    const app = await createApp(dbMock);

    const res = await request(app).get("/sitemap.xml");

    expect(res.headers["cache-control"]).toMatch(/public/);
    expect(res.headers["cache-control"]).toMatch(/max-age=3600/);
  }, 15000);

  it("includes lastmod dates formatted as YYYY-MM-DD", async () => {
    const dbMock = createMockDb({
      companies: [
        { id: "c1", name: "Alpha", issuePrefix: "A", updatedAt: new Date("2025-06-01T12:00:00Z") },
      ],
      issues: [],
    });
    const app = await createApp(dbMock);

    const res = await request(app).get("/sitemap.xml");
    const body = res.text;

    // First company entry should have lastmod 2025-06-01
    expect(body).toContain("<lastmod>2025-06-01</lastmod>");
  }, 15000);

  it("includes changefreq weekly on each url", async () => {
    const dbMock = createMockDb({
      companies: [
        { id: "c1", name: "TestCo", issuePrefix: "TST", updatedAt: new Date("2025-06-01") },
      ],
      issues: [],
    });
    const app = await createApp(dbMock);

    const res = await request(app).get("/sitemap.xml");
    const body = res.text;

    expect(body).toContain("<changefreq>weekly</changefreq>");
  }, 15000);
});

describe("GET /sitemap.xml — error resilience", () => {
  it("returns 200 with empty urlset on DB query failure", async () => {
    const dbMock = createMockDb({ throwOnIssues: true });
    const app = await createApp(dbMock);

    const res = await request(app).get("/sitemap.xml");
    const body = res.text;

    expect(res.status).toBe(200);
    expect(body).toContain("<urlset");
    expect(body).toContain("</urlset>");
    // Should not contain any <url> elements since DB failed
    expect(body).not.toContain("<url>");
  }, 15000);

  it("sets Cache-Control: no-cache on DB error", async () => {
    const dbMock = createMockDb({ throwOnIssues: true });
    const app = await createApp(dbMock);

    const res = await request(app).get("/sitemap.xml");

    expect(res.headers["cache-control"]).toBe("no-cache");
  }, 15000);
});

describe("XML injection prevention", () => {
  it("escapes XML special characters in hostname via X-Forwarded-Host in sitemap.xml", async () => {
    const dbMock = createMockDb({
      companies: [],
      issues: [],
    });
    const app = await createApp(dbMock);

    const maliciousHost = 'example.com"><script>alert(1)</script>';
    const res = await request(app)
      .get("/sitemap.xml")
      .set("X-Forwarded-Host", maliciousHost);

    const body = res.text;
    expect(body).not.toContain("<script>");
    expect(body).toContain("&lt;script&gt;");
  }, 15000);
});

describe("GET /sitemap.xml — XML validity", () => {
  it("produces well-formed XML with matching url open/close tags", async () => {
    const dbMock = createMockDb({
      companies: [
        { id: "c1", name: "Company", issuePrefix: "CO", updatedAt: new Date("2025-01-01") },
      ],
      issues: [
        {
          id: "i1",
          identifier: "CO-1",
          title: "Test issue",
          companyId: "c1",
          updatedAt: new Date("2025-06-01"),
        },
      ],
    });
    const app = await createApp(dbMock);

    const res = await request(app).get("/sitemap.xml");

    const body = res.text;
    // Verify XML structure
    expect(body).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?>/);
    expect(body).toMatch(/<urlset[^>]*>/);
    expect(body).toMatch(/<\/urlset>$/);

    // Count opening and closing <url> tags to ensure they balance
    const openUrls = (body.match(/<url>/g) || []).length;
    const closeUrls = (body.match(/<\/url>/g) || []).length;
    expect(openUrls).toBe(closeUrls);
    expect(openUrls).toBeGreaterThan(0);
  }, 15000);
});
