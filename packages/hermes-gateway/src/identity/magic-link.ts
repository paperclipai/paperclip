import { SignJWT, jwtVerify, errors } from "jose";
import { randomUUID } from "node:crypto";
import type { MagicLinkPayload } from "./types.js";

const ISSUER = "hermes-gateway";
const AUDIENCE = "hermes-bind";
const TTL_SECONDS = 900; // 15 minutes

export class MagicLinkService {
  private readonly secret: Uint8Array;
  private readonly baseUrl: string;

  constructor(jwtSecret: string, bindBaseUrl: string) {
    this.secret = new TextEncoder().encode(jwtSecret);
    this.baseUrl = bindBaseUrl.replace(/\/$/, "");
  }

  async generateLink(payload: MagicLinkPayload): Promise<{ url: string; token: string }> {
    const token = await new SignJWT({
      platform: payload.platform,
      platformUserId: payload.platformUserId,
      companyId: payload.companyId,
      displayName: payload.displayName,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setJti(randomUUID())
      .setIssuedAt()
      .setExpirationTime(`${TTL_SECONDS}s`)
      .sign(this.secret);

    const url = `${this.baseUrl}/bind?token=${encodeURIComponent(token)}`;
    return { url, token };
  }

  async verifyToken(token: string): Promise<MagicLinkPayload> {
    try {
      const { payload } = await jwtVerify(token, this.secret, {
        issuer: ISSUER,
        audience: AUDIENCE,
      });

      const platform = payload["platform"];
      const platformUserId = payload["platformUserId"];
      const companyId = payload["companyId"];
      const displayName = payload["displayName"];

      if (typeof platform !== "string" || typeof platformUserId !== "string" || typeof companyId !== "string") {
        throw new Error("Invalid token payload: missing required fields");
      }

      return {
        platform,
        platformUserId,
        companyId,
        displayName: typeof displayName === "string" ? displayName : null,
      };
    } catch (err) {
      if (err instanceof errors.JWTExpired) {
        throw new Error("Bind token has expired. Please request a new link.");
      }
      if (err instanceof errors.JWTClaimValidationFailed) {
        throw new Error("Invalid bind token.");
      }
      throw err;
    }
  }
}
