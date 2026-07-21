import { describe, expect, it } from "vitest";
import { resolveStorageProviderDefault } from "../config.js";

describe("cloud storage defaults", () => {
  it("defaults cloud runtimes to S3 without overriding explicit configuration", () => {
    expect(resolveStorageProviderDefault({ inCloudRuntime: true })).toBe("s3");
    expect(resolveStorageProviderDefault({ inCloudRuntime: false })).toBe("local_disk");
    expect(resolveStorageProviderDefault({ inCloudRuntime: true, fileProvider: "local_disk" })).toBe("local_disk");
    expect(resolveStorageProviderDefault({ inCloudRuntime: false, envProvider: "s3" })).toBe("s3");
  });
});
