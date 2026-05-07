import { SignJWT } from 'jose';
import { OIDCConfigurationError } from './errors';

const SECRET_ENV = 'CADDY_SESSION_JWT_SECRET';

function getSecret(): Uint8Array {
  const raw = process.env[SECRET_ENV];
  if (!raw) {
    throw new OIDCConfigurationError(
      `${SECRET_ENV} is not set — Caddy session JWT cannot be minted`
    );
  }
  // ggicci/caddy-jwt base64-decodes sign_key before using it as the HMAC key,
  // so we must decode here to get the same key bytes Caddy will verify against.
  return new Uint8Array(Buffer.from(raw, 'base64'));
}

export interface CaddyJwtPayload {
  email: string;
  roles: string[];
  sub: string;
}

export async function mintCaddyJwt(payload: CaddyJwtPayload): Promise<string> {
  const secret = getSecret();
  return new SignJWT({
    email: payload.email,
    roles: payload.roles,
    sub: payload.sub,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('8h')
    .setIssuer('ops-portal-vercel')
    .setAudience('paperclip-ops-caddy')
    .sign(secret);
}
