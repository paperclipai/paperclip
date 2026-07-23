import { describe, expect, it } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { pluginCapabilityValidator } from "../services/plugin-capability-validator.js";

const manifest: PaperclipPluginManifestV1 = {
  id: "test.approval-slots",
  apiVersion: 1,
  version: "1.0.0",
  displayName: "Approval Slots",
  description: "Test approval slot plugin",
  author: "Paperclip",
  categories: ["ui"],
  capabilities: ["ui.approval.register"],
  entrypoints: {
    worker: "dist/worker.js",
    ui: "dist/ui.js",
  },
  ui: {
    slots: [
      {
        type: "approvalCard",
        id: "approval-card",
        displayName: "Approval Card",
        exportName: "ApprovalCard",
      },
      {
        type: "approvalPayloadField",
        id: "approval-payload-field",
        displayName: "Approval Payload Field",
        exportName: "ApprovalPayloadField",
      },
    ],
  },
};

describe("plugin approval UI slots", () => {
  it("requires ui.approval.register for approval card and payload field slots", () => {
    const validator = pluginCapabilityValidator();

    expect(validator.getUiSlotCapability("approvalCard")).toBe("ui.approval.register");
    expect(validator.getUiSlotCapability("approvalPayloadField")).toBe("ui.approval.register");
    expect(validator.checkUiSlot(manifest, "approvalCard")).toMatchObject({ allowed: true });
    expect(validator.checkUiSlot(manifest, "approvalPayloadField")).toMatchObject({ allowed: true });

    const withoutCapability = {
      ...manifest,
      capabilities: ["ui.detailTab.register"],
    } satisfies PaperclipPluginManifestV1;

    expect(validator.checkUiSlot(withoutCapability, "approvalCard")).toMatchObject({
      allowed: false,
      missing: ["ui.approval.register"],
    });
    expect(validator.validateManifestCapabilities(withoutCapability)).toMatchObject({
      allowed: false,
      missing: ["ui.approval.register"],
    });
  });
});
