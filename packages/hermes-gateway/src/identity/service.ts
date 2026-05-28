import type { IdentityStore } from "./store.js";
import type { MagicLinkService } from "./magic-link.js";
import type { IdentityBinding, BindResult } from "./types.js";

export class IdentityService {
  constructor(
    private readonly store: IdentityStore,
    private readonly magicLink: MagicLinkService,
  ) {}

  async lookup(platform: string, platformUserId: string): Promise<IdentityBinding | null> {
    return this.store.findBinding(platform, platformUserId);
  }

  async requestBind(params: {
    platform: string;
    platformUserId: string;
    companyId: string;
    displayName: string | null;
  }): Promise<{ url: string }> {
    const existing = await this.store.findBinding(params.platform, params.platformUserId);
    if (existing) {
      throw new Error("User is already bound. Use /unbind first to rebind.");
    }

    const { url } = await this.magicLink.generateLink({
      platform: params.platform,
      platformUserId: params.platformUserId,
      companyId: params.companyId,
      displayName: params.displayName,
    });

    return { url };
  }

  async completeBind(token: string, paperclipUserId: string): Promise<BindResult> {
    const payload = await this.magicLink.verifyToken(token);

    const existing = await this.store.findBinding(payload.platform, payload.platformUserId);
    if (existing) {
      return { binding: existing, isNew: false };
    }

    const binding = await this.store.createBinding({
      platform: payload.platform,
      platformUserId: payload.platformUserId,
      paperclipUserId,
      paperclipCompanyId: payload.companyId,
      displayName: payload.displayName,
    });

    return { binding, isNew: true };
  }

  async unbind(platform: string, platformUserId: string): Promise<boolean> {
    return this.store.revokeBinding(platform, platformUserId);
  }
}
