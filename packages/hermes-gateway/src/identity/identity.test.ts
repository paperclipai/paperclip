import { describe, it, expect, beforeEach } from "vitest";
import { MagicLinkService } from "./magic-link.js";
import { IdentityService } from "./service.js";
import type { IdentityStore } from "./store.js";
import type { IdentityBinding } from "./types.js";

class InMemoryIdentityStore implements IdentityStore {
  private bindings: IdentityBinding[] = [];

  async findBinding(platform: string, platformUserId: string): Promise<IdentityBinding | null> {
    return (
      this.bindings.find(
        (b) => b.platform === platform && b.platformUserId === platformUserId && !b.revokedAt,
      ) ?? null
    );
  }

  async createBinding(params: {
    platform: string;
    platformUserId: string;
    paperclipUserId: string;
    paperclipCompanyId: string;
    displayName: string | null;
  }): Promise<IdentityBinding> {
    const binding: IdentityBinding = {
      id: crypto.randomUUID(),
      platform: params.platform,
      platformUserId: params.platformUserId,
      paperclipUserId: params.paperclipUserId,
      paperclipCompanyId: params.paperclipCompanyId,
      displayName: params.displayName,
      boundAt: new Date(),
      revokedAt: null,
    };
    this.bindings.push(binding);
    return binding;
  }

  async revokeBinding(platform: string, platformUserId: string): Promise<boolean> {
    const binding = this.bindings.find(
      (b) => b.platform === platform && b.platformUserId === platformUserId && !b.revokedAt,
    );
    if (!binding) return false;
    binding.revokedAt = new Date();
    return true;
  }
}

const TEST_SECRET = "test-jwt-secret-at-least-32-chars-long";
const TEST_BASE_URL = "https://hermes.test";

describe("MagicLinkService", () => {
  let magicLink: MagicLinkService;

  beforeEach(() => {
    magicLink = new MagicLinkService(TEST_SECRET, TEST_BASE_URL);
  });

  it("generates a valid magic link URL", async () => {
    const { url, token } = await magicLink.generateLink({
      platform: "telegram",
      platformUserId: "12345",
      companyId: "company-uuid",
      displayName: "Tom",
    });

    expect(url).toContain(`${TEST_BASE_URL}/bind?token=`);
    expect(token).toBeTruthy();
  });

  it("verifies a valid token", async () => {
    const { token } = await magicLink.generateLink({
      platform: "telegram",
      platformUserId: "12345",
      companyId: "company-uuid",
      displayName: "Tom",
    });

    const payload = await magicLink.verifyToken(token);
    expect(payload.platform).toBe("telegram");
    expect(payload.platformUserId).toBe("12345");
    expect(payload.companyId).toBe("company-uuid");
    expect(payload.displayName).toBe("Tom");
  });

  it("rejects a token signed with a different secret", async () => {
    const otherService = new MagicLinkService("other-secret-that-is-also-32-chars", TEST_BASE_URL);
    const { token } = await otherService.generateLink({
      platform: "telegram",
      platformUserId: "12345",
      companyId: "company-uuid",
      displayName: null,
    });

    await expect(magicLink.verifyToken(token)).rejects.toThrow();
  });
});

describe("IdentityService", () => {
  let store: InMemoryIdentityStore;
  let magicLink: MagicLinkService;
  let service: IdentityService;

  beforeEach(() => {
    store = new InMemoryIdentityStore();
    magicLink = new MagicLinkService(TEST_SECRET, TEST_BASE_URL);
    service = new IdentityService(store, magicLink);
  });

  it("returns null for unbound user", async () => {
    const result = await service.lookup("telegram", "unknown-user");
    expect(result).toBeNull();
  });

  it("generates a bind link for unbound user", async () => {
    const { url } = await service.requestBind({
      platform: "telegram",
      platformUserId: "12345",
      companyId: "company-uuid",
      displayName: "Tom",
    });

    expect(url).toContain("/bind?token=");
  });

  it("rejects bind request for already-bound user", async () => {
    await store.createBinding({
      platform: "telegram",
      platformUserId: "12345",
      paperclipUserId: "user-uuid",
      paperclipCompanyId: "company-uuid",
      displayName: "Tom",
    });

    await expect(
      service.requestBind({
        platform: "telegram",
        platformUserId: "12345",
        companyId: "company-uuid",
        displayName: "Tom",
      }),
    ).rejects.toThrow("already bound");
  });

  it("completes bind flow end-to-end", async () => {
    const { url } = await service.requestBind({
      platform: "telegram",
      platformUserId: "12345",
      companyId: "company-uuid",
      displayName: "Tom",
    });

    const token = new URL(url).searchParams.get("token")!;
    const result = await service.completeBind(token, "paperclip-user-uuid");

    expect(result.isNew).toBe(true);
    expect(result.binding.platform).toBe("telegram");
    expect(result.binding.platformUserId).toBe("12345");
    expect(result.binding.paperclipUserId).toBe("paperclip-user-uuid");
  });

  it("returns existing binding on duplicate completeBind", async () => {
    const { url } = await service.requestBind({
      platform: "telegram",
      platformUserId: "12345",
      companyId: "company-uuid",
      displayName: "Tom",
    });

    const token = new URL(url).searchParams.get("token")!;
    await service.completeBind(token, "paperclip-user-uuid");

    const { token: token2 } = await magicLink.generateLink({
      platform: "telegram",
      platformUserId: "12345",
      companyId: "company-uuid",
      displayName: "Tom",
    });
    const result2 = await service.completeBind(token2, "different-user");
    expect(result2.isNew).toBe(false);
    expect(result2.binding.paperclipUserId).toBe("paperclip-user-uuid");
  });

  it("unbinds a bound user", async () => {
    await store.createBinding({
      platform: "telegram",
      platformUserId: "12345",
      paperclipUserId: "user-uuid",
      paperclipCompanyId: "company-uuid",
      displayName: "Tom",
    });

    const revoked = await service.unbind("telegram", "12345");
    expect(revoked).toBe(true);

    const lookup = await service.lookup("telegram", "12345");
    expect(lookup).toBeNull();
  });

  it("unbind returns false for unbound user", async () => {
    const revoked = await service.unbind("telegram", "nonexistent");
    expect(revoked).toBe(false);
  });

  it("allows rebind after unbind", async () => {
    await store.createBinding({
      platform: "telegram",
      platformUserId: "12345",
      paperclipUserId: "old-user",
      paperclipCompanyId: "company-uuid",
      displayName: "Tom",
    });

    await service.unbind("telegram", "12345");

    const { url } = await service.requestBind({
      platform: "telegram",
      platformUserId: "12345",
      companyId: "company-uuid",
      displayName: "Tom",
    });

    const token = new URL(url).searchParams.get("token")!;
    const result = await service.completeBind(token, "new-user");
    expect(result.isNew).toBe(true);
    expect(result.binding.paperclipUserId).toBe("new-user");
  });
});
