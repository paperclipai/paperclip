import { afterEach, describe, expect, it } from "vitest";
import {
  __resetPluginModuleOrigins,
  readPluginModuleOrigin,
  rememberPluginModuleUrl,
} from "./plugin-module-origins";

const hostFrame = { filename: "/assets/index.js", abs_path: "https://app.example/assets/index.js" };

afterEach(() => __resetPluginModuleOrigins());

describe("readPluginModuleOrigin", () => {
  it("names the plugin of the innermost blob frame", () => {
    rememberPluginModuleUrl("blob:https://app.example/outer", "acme.outer");
    rememberPluginModuleUrl("blob:https://app.example/inner", "acme.inner");
    expect(readPluginModuleOrigin([{
      stacktrace: { frames: [
        { filename: "blob:https://app.example/outer" },
        hostFrame,
        { abs_path: "blob:https://app.example/inner", filename: "blob:https://app.example/inner" },
      ] },
    }])).toBe("acme.inner");
  });

  it("reports an unrecorded blob module as unmapped", () => {
    expect(readPluginModuleOrigin([{
      stacktrace: { frames: [hostFrame, { filename: "blob:https://app.example/unknown" }] },
    }])).toBe("unmapped");
  });

  it("adds nothing when no frame ran from a blob module", () => {
    rememberPluginModuleUrl("blob:https://app.example/module", "acme.plugin");
    expect(readPluginModuleOrigin([{ stacktrace: { frames: [hostFrame] } }])).toBeUndefined();
    expect(readPluginModuleOrigin([{}])).toBeUndefined();
    expect(readPluginModuleOrigin(undefined)).toBeUndefined();
  });

  it("keeps only the most recent modules", () => {
    for (let index = 0; index <= 100; index += 1) {
      rememberPluginModuleUrl(`blob:https://app.example/${index}`, `acme.plugin-${index}`);
    }
    const frameFor = (index: number) => [{ stacktrace: { frames: [{ filename: `blob:https://app.example/${index}` }] } }];
    expect(readPluginModuleOrigin(frameFor(0))).toBe("unmapped");
    expect(readPluginModuleOrigin(frameFor(100))).toBe("acme.plugin-100");
  });

  it("bounds the tag to Sentry's value length", () => {
    rememberPluginModuleUrl("blob:https://app.example/long", "a".repeat(300));
    expect(readPluginModuleOrigin([{ stacktrace: { frames: [{ filename: "blob:https://app.example/long" }] } }]))
      .toHaveLength(200);
  });
});
