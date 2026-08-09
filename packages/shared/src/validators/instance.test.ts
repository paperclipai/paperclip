import { describe, expect, it } from "vitest";
import {
  instanceExperimentalSettingsSchema,
  patchInstanceExperimentalSettingsSchema,
} from "./instance.js";

describe("instance experimental settings validators", () => {
  it("defaults the server info debug view off", () => {
    const settings = instanceExperimentalSettingsSchema.parse({});

    expect(settings.enableServerInfoDebugView).toBe(false);
  });

  it("accepts server info debug view patches", () => {
    expect(
      patchInstanceExperimentalSettingsSchema.parse({
        enableServerInfoDebugView: true,
      }),
    ).toEqual({
      enableServerInfoDebugView: true,
    });
  });
});
