import { describe, expect, it } from "vitest";
import type { IssueAttachment, IssueWorkProduct } from "@paperclipai/shared";
import type { TaskChatItem, TaskChatMaterializedResourceItem } from "./task-chat-model";
import { groupImageResources } from "./image-resources";

function image(id: string, run = "run-1", contentType = "image/png"): TaskChatMaterializedResourceItem {
  return { id, kind: "protocol", surface: "resource", resourceKind: "deliverable", title: `${id}.png`, subtitle: "Image", href: `/images/${id}.png`,
    workProduct: { id, type: "artifact", title: `${id}.png`, createdByRunId: run,
      metadata: { contentType, contentPath: `/images/${id}.png` } } as unknown as IssueWorkProduct };
}

describe("image resources in a results stream", () => {
  it("keeps the first row and each tile identity as images arrive, without mutating prior renders", () => {
    const first = image("one");
    const before = groupImageResources([first, image("two")]);
    const after = groupImageResources([first, image("two"), image("three")]);
    expect(before).toHaveLength(1);
    expect(after[0].id).toBe(before[0].id);
    expect(before[0].imageItems?.map(i => i.id)).toEqual(["one", "two"]);
    expect(after[0].imageItems?.map(i => i.id)).toEqual(["one", "two", "three"]);
    expect(first.imageItems).toBeUndefined();
  });

  it("preserves text, document, video and different-run boundaries in chronological order", () => {
    const text: TaskChatItem = { id: "text", kind: "message", author: "agent", text: "Next version" };
    const doc = { ...image("doc"), resourceKind: "document" as const, workProduct: undefined };
    const video = image("video", "run-1", "video/mp4");
    const rows = groupImageResources([image("a"), image("b"), text, image("c"), doc, image("d"), video, image("e"), image("f", "run-2")]);
    expect(rows.map(i => i.id)).toEqual(["a", "text", "c", "doc", "d", "video", "e", "f"]);
    expect(rows[1]).toBe(text);
    expect(rows[3]).toBe(doc);
    expect(rows[5]).toBe(video);
  });

  it.each([null, undefined])("keeps images without a run separate (%s)", (runId) => {
    const unattributed = (id: string) => {
      const item = image(id);
      return { ...item, workProduct: { ...item.workProduct!, createdByRunId: runId } as IssueWorkProduct };
    };
    const text: TaskChatItem = { id: "text", kind: "message", author: "agent", text: "Next turn" };
    const rows = groupImageResources([unattributed("a"), unattributed("b"), text, unattributed("c")]);
    expect(rows.map(row => row.id)).toEqual(["a", "b", "text", "c"]);
    expect(rows[0]).toMatchObject({ imageItems: [{ id: "a" }] });
    expect(rows[1]).toMatchObject({ imageItems: [{ id: "b" }] });
  });

  it("groups unregistered image uploads with work products from the same run", () => {
    const attachment: TaskChatMaterializedResourceItem = { id: "upload", kind: "protocol", surface: "resource", resourceKind: "attachment", title: "upload.png", subtitle: "Image", href: "/upload.png",
      attachment: { id: "upload", contentType: "application/octet-stream", originalFilename: "upload.png", contentPath: "/upload.png", originatingRunId: "run-1" } as IssueAttachment } satisfies TaskChatMaterializedResourceItem;
    expect(groupImageResources([image("one"), attachment])[0].imageItems?.map(i => i.id)).toEqual(["one", "upload"]);
    expect(groupImageResources([attachment, image("two", "run-2")])).toHaveLength(2);
  });

  it("leaves missing-image-path resources available as ordinary cards", () => {
    const broken = { ...image("broken"), href: null, workProduct: { ...image("broken").workProduct!, metadata: { contentType: "image/png" } } };
    expect(groupImageResources([broken])[0]).toBe(broken);
  });

  it("groups a realistic large feed in one pass and can safely group an already grouped feed", () => {
    let reads = 0;
    const items = Array.from({ length: 2000 }, (_, n) => {
      const item = image(`${n}`, `run-${Math.floor(n / 8)}`);
      const product = item.workProduct!;
      Object.defineProperty(item, "workProduct", { enumerable: true, get() { if (++reads > 20000) throw new Error("repeated scan"); return product; } });
      return item;
    });
    const rows = groupImageResources(items);
    expect(rows).toHaveLength(250);
    expect(rows.every(r => r.imageItems?.length === 8)).toBe(true);
    expect(groupImageResources(rows)).toEqual(rows);
    expect(reads).toBeLessThan(20000);
  });
});
