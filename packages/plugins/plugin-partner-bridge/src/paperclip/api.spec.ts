import { describe, expect, it } from "vitest";
import { FakePaperclipApi } from "./api.js";

describe("FakePaperclipApi", () => {
  it("postComment then listComments returns it; sinceTs filters", async () => {
    const api = new FakePaperclipApi();
    await api.postComment("iss", "hello", { class: "routine" });
    const all = await api.listComments("iss");
    expect(all).toHaveLength(1);
    expect(all[0].body).toBe("hello");
    const future = await api.listComments("iss", "2999-01-01T00:00:00Z");
    expect(future).toHaveLength(0);
  });
  it("createIssue + putDocument/getDocument round-trip", async () => {
    const api = new FakePaperclipApi();
    const iss = await api.createIssue("co", { title: "T", description: "D" });
    expect(iss.identifier).toMatch(/-\d+$/);
    await api.putDocument(iss.id, "brief", { title: "B", body: "body", format: "markdown" });
    expect((await api.getDocument(iss.id, "brief"))?.body).toBe("body");
  });
  it("createApproval starts pending; resolveApproval flips status", async () => {
    const api = new FakePaperclipApi();
    const ap = await api.createApproval("co", { kind: "request_board_approval", summary: "s" });
    expect(ap.status).toBe("pending");
    const r = await api.resolveApproval(ap.id, "approve");
    expect(r.status).toBe("approved");
  });
});
