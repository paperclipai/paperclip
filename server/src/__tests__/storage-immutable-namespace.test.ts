import { describe, expect, it } from "vitest";
import { createS3StorageProvider } from "../storage/s3-provider.js";
import { createStorageService } from "../storage/service.js";

const config = { bucket: "fixture", region: "us-east-1", endpoint: "https://storage.example.test", prefix: "root", forcePathStyle: true };
describe("immutable object namespace", () => {
  it("propagates the opaque resource identity without credential material", () => {
    const provider = createS3StorageProvider(config), service = createStorageService(provider);
    expect(provider.immutableObjectNamespace).toMatch(/^[a-f0-9]{64}$/);
    expect(service.immutableObjectNamespace).toBe(provider.immutableObjectNamespace);
    expect(createS3StorageProvider({ ...config, endpoint: "https://storage.example.test/", prefix: "/root/" }).immutableObjectNamespace)
      .toBe(provider.immutableObjectNamespace);
  });
  it.each([
    { bucket: "other" }, { region: "us-west-2" }, { endpoint: "https://other.example.test" },
    { prefix: "other" }, { forcePathStyle: false },
  ])("separates a changed resource location %j", change => {
    expect(createS3StorageProvider({ ...config, ...change }).immutableObjectNamespace)
      .not.toBe(createS3StorageProvider(config).immutableObjectNamespace);
  });
  it("does not attest an endpoint selected implicitly by SDK profiles or environment", () => {
    expect(createS3StorageProvider({ bucket: "fixture", region: "us-east-1" }).immutableObjectNamespace).toBeUndefined();
  });
});
