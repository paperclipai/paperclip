import { describe, expect, it } from "vitest";
import { createGoogleHttp } from "../google-http.js";
import { fakeGoogle, json } from "../fixtures/fake-google.js";
import { LABEL_LIST } from "./fixtures/gmail-rest.js";
import { listLabels, listLabelsRequest, listLabelsResult } from "./list-labels.js";

describe("list_labels request", () => {
  it("reads the label list in one request", () => {
    expect(listLabelsRequest()).toEqual({ method: "GET", host: "gmail.googleapis.com", path: "/gmail/v1/users/me/labels" });
  });
});

describe("list_labels result", () => {
  it("returns user labels only, sorted by name, with complete colors", () => {
    expect(listLabelsResult(LABEL_LIST, {}).structuredContent).toEqual({
      labels: [
        { labelId: "Label_42", name: "Projects" },
        { labelId: "Label_3", name: "Projects/Plan" },
        { labelId: "Label_7", name: "Receipts", color: { textColor: "#000000", backgroundColor: "#4a86e8" } },
      ],
    });
  });

  it("pages through the list", () => {
    const first = listLabelsResult(LABEL_LIST, { pageSize: 2 }).structuredContent as { labels: Array<{ labelId: string }>; nextPageToken: string };
    expect(first.labels.map((label) => label.labelId)).toEqual(["Label_42", "Label_3"]);
    expect(first.nextPageToken).toBe("2");
    expect(listLabelsResult(LABEL_LIST, { pageSize: 2, pageToken: first.nextPageToken }).structuredContent).toEqual({
      labels: [{ labelId: "Label_7", name: "Receipts", color: { textColor: "#000000", backgroundColor: "#4a86e8" } }],
    });
    expect(listLabelsResult(LABEL_LIST, { pageToken: "99" }).structuredContent).toEqual({ labels: [] });
  });

  it("caps the page size at 500", () => {
    const labels = Array.from({ length: 600 }, (_, index) => ({ id: `Label_${index}`, name: `L${String(index).padStart(3, "0")}`, type: "user" }));
    const page = listLabelsResult({ labels }, { pageSize: 10_000 }).structuredContent as { labels: unknown[]; nextPageToken: string };
    expect(page.labels).toHaveLength(500);
    expect(page.nextPageToken).toBe("500");
  });
});

describe("list_labels tool", () => {
  it("makes one request and rejects a page token it did not issue", async () => {
    const { fetch, calls } = fakeGoogle(() => json(LABEL_LIST));
    const http = createGoogleHttp({ accessToken: "t", fetch });
    expect((await listLabels.call({}, http)).isError).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect((await listLabels.call({ pageToken: "abc" }, http)).isError).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("treats an empty page token as the first page", async () => {
    const { fetch } = fakeGoogle(() => json(LABEL_LIST));
    const result = await listLabels.call({ pageToken: "", pageSize: 1 }, createGoogleHttp({ accessToken: "t", fetch }));
    expect(result.structuredContent).toEqual({ labels: [{ labelId: "Label_42", name: "Projects" }], nextPageToken: "1" });
  });
});
