import { describe, expect, it } from "vitest";
import { companyPortabilityService } from "../services/company-portability.js";

describe("services/company-portability.ts", () => {
  it("exposes portability service methods", () => {
    const service = companyPortabilityService({} as any);
    expect(service).toMatchObject({
      exportBundle: expect.any(Function),
      importBundle: expect.any(Function),
      previewExport: expect.any(Function),
      previewImport: expect.any(Function),
    });
  });
});

