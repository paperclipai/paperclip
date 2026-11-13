import { describe, expect, it } from "vitest";
import {
  latestStoryDelivery,
  type StoryDelivery,
} from "./everyday-delivery.js";
const attachment = (
  issueId: string,
  id: string,
  createdAt = "2026-09-14T12:00:00Z",
): StoryDelivery => ({
  issueId,
  id,
  createdAt,
  originalFilename: "project.zip",
});
describe("delegated user delivery", () => {
  it.each(["parent", "child"])(
    "accepts a ZIP delivered on the %s task",
    (issue) => {
      expect(
        latestStoryDelivery([attachment(issue, "zip")], ["parent", "child"])
          ?.id,
      ).toBe("zip");
    },
  );
  it("does not borrow a ZIP from an unrelated task", () => {
    expect(
      latestStoryDelivery(
        [attachment("unrelated", "zip")],
        ["parent", "child"],
      ),
    ).toBeUndefined();
  });
  it("requires a new delivery after the revision request and chooses it across both tasks", () => {
    const old = attachment("parent", "initial");
    const cutoff = Date.parse("2026-09-14T12:05:00Z");
    expect(
      latestStoryDelivery([old], ["parent", "child"], cutoff),
    ).toBeUndefined();
    const revised = attachment("child", "revised", "2026-09-14T12:06:00Z");
    expect(
      latestStoryDelivery([old, revised], ["parent", "child"], cutoff)?.id,
    ).toBe("revised");
  });
  it("ignores the preserved original even when it is republished after the revision", () => {
    const revised = { ...attachment("child", "revised", "2026-09-14T12:06:00Z"), sha256: "new-content" };
    const preserved = { ...attachment("parent", "original-copy", "2026-09-14T12:07:00Z"), sha256: "original-content" };
    const cutoff = Date.parse("2026-09-14T12:05:00Z");
    expect(latestStoryDelivery([revised, preserved], ["parent", "child"], cutoff, ["original-content"])?.id).toBe("revised");
    expect(latestStoryDelivery([preserved], ["parent", "child"], cutoff, ["original-content"])).toBeUndefined();
  });
  it("rejects source files and malformed timestamps", () => {
    expect(
      latestStoryDelivery(
        [
          { ...attachment("parent", "source"), originalFilename: "source.py" },
          attachment("child", "invalid", "unknown"),
        ],
        ["parent", "child"],
      ),
    ).toBeUndefined();
  });
});
