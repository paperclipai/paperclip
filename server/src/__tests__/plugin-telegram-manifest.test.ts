import { describe, expect, it } from "vitest";
import manifest from "../../../packages/plugins/plugin-pc-telegram/src/manifest.js";
import { pluginCapabilityValidator } from "../services/plugin-capability-validator.js";

describe("telegram inbox plugin installation", () => {
  it("accepts the inbox page and chats nav through the host manifest checks", () => {
    const validator = pluginCapabilityValidator();
    expect(manifest.ui?.slots).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "page", exportName: "TelegramInboxPage", routePath: "telegram-inbox" }),
      expect.objectContaining({ type: "sidebar", exportName: "TelegramChatsNav" }),
    ]));
    expect(validator.validateManifestCapabilities(manifest).allowed).toBe(true);
    const withoutUi = {
      ...manifest,
      capabilities: manifest.capabilities.filter((capability) => (
        capability !== "ui.page.register" && capability !== "ui.sidebar.register"
      )),
    };
    expect(validator.validateManifestCapabilities(withoutUi)).toMatchObject({
      allowed: false,
      missing: expect.arrayContaining(["ui.page.register", "ui.sidebar.register"]),
    });
  });
});
