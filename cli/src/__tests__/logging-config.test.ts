import { describe, expect, it } from "vitest";
import { loggingConfigSchema } from "../config/schema.js";

describe("logging config schema", () => {
  it("adds bounded rotation defaults for file logging", () => {
    const config = loggingConfigSchema.parse({
      mode: "file",
      logDir: "/tmp/paperclip-logs",
    });

    expect(config.rotation).toEqual({
      enabled: true,
      maxFileSizeMb: 100,
      maxFiles: 10,
    });
  });
});
