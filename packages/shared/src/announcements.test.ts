import { describe, expect, it } from "vitest";
import { announcementManifestSchema, announcementSchema, isAnnouncementEligible } from "./announcements.js";

const announcement = { id: "new-projects", eyebrow: "New", title: "Projects", description: "Organize your work.", primaryAction: { kind: "route", label: "Open", path: "/projects" } };
describe("announcement contract", () => {
  it("supports an empty feed and a plain-text card", () => {
    expect(announcementManifestSchema.parse({ schemaVersion: 1, announcement: null }).announcement).toBeNull();
    expect(announcementSchema.parse(announcement).id).toBe("new-projects");
    expect(announcementSchema.parse({ ...announcement, title: "<script>alert(1)</script>" }).title).toContain("<script>");
  });
  it.each(["/api/companies", "//evil.test", "/projects/../auth", "/company/settings?danger=yes", "/unknown", "javascript:alert(1)"])("rejects unsupported route %s", (path) => {
    expect(announcementSchema.safeParse({ ...announcement, primaryAction: { kind: "route", label: "Open", path } }).success).toBe(false);
  });
  it.each(["not a URL", "http://example.com", "javascript:alert(1)", "https://user:password@example.com"])("rejects unsafe external URL %s", (url) => {
    expect(announcementSchema.safeParse({ ...announcement, primaryAction: { kind: "external", label: "Open", url } }).success).toBe(false);
  });
  it.each(["../secret.png", "https://example.com/a.png", "/assets/a.png", `assets/${"0".repeat(64)}.svg`])("rejects unsafe image path %s", (path) => {
    expect(announcementSchema.safeParse({ ...announcement, image: { path, alt: "" } }).success).toBe(false);
  });
  it("rejects unknown schema versions and oversized copy", () => {
    expect(announcementManifestSchema.safeParse({ schemaVersion: 2, announcement }).success).toBe(false);
    expect(announcementSchema.safeParse({ ...announcement, description: "a".repeat(401) }).success).toBe(false);
  });
  it("checks expiration and minimum versions numerically, including prereleases", () => {
    const item = announcementSchema.parse({ ...announcement, expiresAt: "2027-01-01T00:00:00Z", minimumPaperclipVersion: "2026.913.0" });
    for (const version of ["2026.912.0", "2026.913.0-canary.1", "unknown"]) expect(isAnnouncementEligible(item, version, 0)).toBe(false);
    for (const version of ["2026.913.0", "2026.913.0+1.git.abc", "2026.1001.0"]) expect(isAnnouncementEligible(item, version, 0)).toBe(true);
    expect(isAnnouncementEligible(item, "2026.913.0", Date.parse(item.expiresAt!))).toBe(false);
  });
});
