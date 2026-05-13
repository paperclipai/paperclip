import { describe, it, expect } from "vitest";
import { buildImagePullSecret } from "../../src/orchestrator/image-pull-secret.js";

describe("buildImagePullSecret", () => {
  it("base64-encodes the dockerconfigjson and sets the dockerconfigjson type", () => {
    const dockerConfig = { auths: { "ghcr.io": { auth: "Zm9vOmJhcg==" } } };
    const s = buildImagePullSecret({
      namespace: "paperclip-acme",
      companyId: "c-1", companySlug: "acme",
      dockerConfigJson: JSON.stringify(dockerConfig),
    });
    expect(s.type).toBe("kubernetes.io/dockerconfigjson");
    expect(s.metadata?.name).toBe("paperclip-image-pull");
    expect(s.metadata?.namespace).toBe("paperclip-acme");
    expect(s.data?.[".dockerconfigjson"]).toBeDefined();
    const decoded = Buffer.from(s.data![".dockerconfigjson"]!, "base64").toString("utf-8");
    expect(JSON.parse(decoded)).toEqual(dockerConfig);
  });

  it("attaches paperclip tenant labels", () => {
    const s = buildImagePullSecret({
      namespace: "paperclip-x", companyId: "c-1", companySlug: "x",
      dockerConfigJson: "{}",
    });
    expect(s.metadata?.labels?.["paperclip.ai/managed-by"]).toBe("paperclip");
    expect(s.metadata?.labels?.["paperclip.ai/company-id"]).toBe("c-1");
  });
});
