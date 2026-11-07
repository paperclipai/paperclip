import { describe, expect, it } from "vitest";
import { defaultSelection, selectedScopes, services } from "./ServiceConsent";

const scope = (name: string) => `https://www.googleapis.com/auth/${name}`;
describe("Workspace service consent preview", () => {
  it("requests nothing before selection", () => {
    expect(selectedScopes({})).toEqual([]);
  });
  it("keeps a Gmail-only reviewer request read-only", () => {
    expect(selectedScopes({ gmail: "read" })).toEqual([scope("gmail.readonly")]);
  });
  it("adds compose only for the explicit draft selection", () => {
    expect(selectedScopes({ gmail: "write" })).toEqual([scope("gmail.compose"), scope("gmail.readonly")]);
  });
  it("checks every supported service with write access by default", () => {
    expect(Object.keys(defaultSelection)).toEqual(services.map(service => service.id));
    expect(Object.values(defaultSelection)).toEqual(Array(3).fill("write"));
    const scopes = selectedScopes(defaultSelection);
    expect(scopes.some(value => value.includes("/auth/chat."))).toBe(false);
    expect(scopes).toContain(scope("gmail.compose"));
    expect(scopes).not.toContain(scope("contacts.readonly"));
    expect(scopes).not.toContain(scope("directory.readonly"));
  });
  it("ignores removed service keys in old preview selections", () => {
    expect(selectedScopes({ chat: "write", search: "read", people: "read", docs: "write", sheets: "write", slides: "write" })).toEqual([]);
  });
  it("combines Drive, Docs, Sheets, and Slides into one deduplicated permission group", () => {
    expect(selectedScopes({ drive: "write" })).toEqual([
      scope("documents"), scope("drive.file"), scope("drive.readonly"), scope("presentations"), scope("spreadsheets"),
    ]);
    expect(selectedScopes({ drive: "read" })).toEqual([
      scope("documents.readonly"), scope("drive.readonly"), scope("presentations.readonly"), scope("spreadsheets.readonly"),
    ]);
  });
});
