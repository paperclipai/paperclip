import { createHmac } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authPasskeys, authTwoFactors, authUsers, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { SoftwarePasskey } from "./helpers/software-passkey.js";
import { createBetterAuthHandler, createBetterAuthInstance } from "../auth/better-auth.js";
import type { Config } from "../config.js";

const ORIGIN = "http://localhost:41998";
const EMAIL = "two-factor@example.com";
const PASSWORD = "correct-horse-battery-staple";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function testConfig(): Config {
  return {
    deploymentMode: "authenticated",
    deploymentExposure: "private",
    authBaseUrlMode: "explicit",
    authPublicBaseUrl: ORIGIN,
    authDisableSignUp: false,
    allowedHostnames: ["localhost"],
    port: 41998,
  } as unknown as Config;
}

function decodeBase32(value: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let buffer = 0;
  const bytes: number[] = [];
  for (const char of value.replace(/=+$/, "").toUpperCase()) {
    const index = alphabet.indexOf(char);
    if (index < 0) throw new Error(`invalid base32 character ${char}`);
    buffer = (buffer << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

function totpCode(totpURI: string, now = Date.now()): string {
  const url = new URL(totpURI);
  const secret = decodeBase32(url.searchParams.get("secret") ?? "");
  const period = Number(url.searchParams.get("period") ?? 30);
  const digits = Number(url.searchParams.get("digits") ?? 6);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 1000 / period)));
  const hmac = createHmac("sha1", secret).update(counter).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const binary = hmac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** digits).padStart(digits, "0");
}

function cookieNames(response: request.Response): string[] {
  const raw = response.headers["set-cookie"];
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return cookies
    .filter((cookie) => !/max-age=0/i.test(cookie))
    .map((cookie) => cookie.split("=", 1)[0] ?? "");
}

describeEmbeddedPostgres("Better Auth two-factor and passkey plugins against the real schema", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;
  let app!: express.Express;
  const originalEnv = {
    secret: process.env.BETTER_AUTH_SECRET,
    rateLimit: process.env.PAPERCLIP_AUTH_RATE_LIMIT_ENABLED,
    publicUrl: process.env.PAPERCLIP_PUBLIC_URL,
  };

  beforeAll(async () => {
    process.env.BETTER_AUTH_SECRET = "better-auth-secret-for-two-factor-tests";
    process.env.PAPERCLIP_AUTH_RATE_LIMIT_ENABLED = "false";
    delete process.env.PAPERCLIP_PUBLIC_URL;

    database = await startEmbeddedPostgresTestDatabase("paperclip-better-auth-two-factor-");
    db = createDb(database.connectionString);

    const { auth } = createBetterAuthInstance(db, testConfig(), [ORIGIN]);
    app = express();
    app.all("/api/auth/{*authPath}", createBetterAuthHandler(auth));
  }, 30_000);

  afterAll(async () => {
    await database?.cleanup();
    if (originalEnv.secret === undefined) delete process.env.BETTER_AUTH_SECRET;
    else process.env.BETTER_AUTH_SECRET = originalEnv.secret;
    if (originalEnv.rateLimit === undefined) delete process.env.PAPERCLIP_AUTH_RATE_LIMIT_ENABLED;
    else process.env.PAPERCLIP_AUTH_RATE_LIMIT_ENABLED = originalEnv.rateLimit;
    if (originalEnv.publicUrl === undefined) delete process.env.PAPERCLIP_PUBLIC_URL;
    else process.env.PAPERCLIP_PUBLIC_URL = originalEnv.publicUrl;
  });

  it("enrolls TOTP, challenges the next password sign-in, and accepts the code and a backup code", async () => {
    const owner = request.agent(app);
    const signUp = await owner
      .post("/api/auth/sign-up/email")
      .set("origin", ORIGIN)
      .send({ email: EMAIL, password: PASSWORD, name: "Two Factor" });
    expect(signUp.status).toBe(200);

    const enable = await owner
      .post("/api/auth/two-factor/enable")
      .set("origin", ORIGIN)
      .send({ password: PASSWORD });
    expect(enable.status).toBe(200);
    const totpURI = enable.body?.totpURI as string;
    const backupCodes = enable.body?.backupCodes as string[];
    expect(totpURI).toMatch(/^otpauth:\/\/totp\/Paperclip:/);
    expect(backupCodes.length).toBeGreaterThan(0);

    const [pendingUser] = await db.select().from(authUsers).where(eq(authUsers.email, EMAIL));
    expect(pendingUser?.twoFactorEnabled).toBe(false);

    const confirm = await owner
      .post("/api/auth/two-factor/verify-totp")
      .set("origin", ORIGIN)
      .send({ code: totpCode(totpURI) });
    expect(confirm.status).toBe(200);

    const [enabledUser] = await db.select().from(authUsers).where(eq(authUsers.email, EMAIL));
    expect(enabledUser?.twoFactorEnabled).toBe(true);
    const twoFactorRows = await db.select().from(authTwoFactors).where(eq(authTwoFactors.userId, enabledUser!.id));
    expect(twoFactorRows).toHaveLength(1);
    expect(twoFactorRows[0]?.verified).toBe(true);
    expect(twoFactorRows[0]?.secret).not.toContain(new URL(totpURI).searchParams.get("secret"));

    const browser = request.agent(app);
    const challenged = await browser
      .post("/api/auth/sign-in/email")
      .set("origin", ORIGIN)
      .send({ email: EMAIL, password: PASSWORD });
    expect(challenged.status).toBe(200);
    expect(challenged.body).toMatchObject({ twoFactorRedirect: true, twoFactorMethods: ["totp"] });
    expect(cookieNames(challenged).some((name) => name.includes("session_token"))).toBe(false);

    const currentCode = totpCode(totpURI);
    const wrongCode = await browser
      .post("/api/auth/two-factor/verify-totp")
      .set("origin", ORIGIN)
      .send({ code: currentCode === "000000" ? "111111" : "000000" });
    expect(wrongCode.status).toBe(401);

    const verified = await browser
      .post("/api/auth/two-factor/verify-totp")
      .set("origin", ORIGIN)
      .send({ code: totpCode(totpURI) });
    expect(verified.status).toBe(200);
    expect(cookieNames(verified).some((name) => name.includes("session_token"))).toBe(true);

    const backupBrowser = request.agent(app);
    await backupBrowser
      .post("/api/auth/sign-in/email")
      .set("origin", ORIGIN)
      .send({ email: EMAIL, password: PASSWORD })
      .expect(200);
    const backup = await backupBrowser
      .post("/api/auth/two-factor/verify-backup-code")
      .set("origin", ORIGIN)
      .send({ code: backupCodes[0] });
    expect(backup.status).toBe(200);
    expect(cookieNames(backup).some((name) => name.includes("session_token"))).toBe(true);
  });

  it("registers a passkey and signs in with it without a password", async () => {
    const owner = request.agent(app);
    await owner
      .post("/api/auth/sign-up/email")
      .set("origin", ORIGIN)
      .send({ email: "passkey@example.com", password: PASSWORD, name: "Passkey" })
      .expect(200);

    const anonymous = await request(app).get("/api/auth/passkey/generate-register-options").set("origin", ORIGIN);
    expect(anonymous.status).toBe(401);

    const registerOptions = await owner.get("/api/auth/passkey/generate-register-options").set("origin", ORIGIN);
    expect(registerOptions.status).toBe(200);
    expect(registerOptions.body?.rp).toMatchObject({ id: "localhost", name: "Paperclip" });
    expect(registerOptions.body?.authenticatorSelection).toMatchObject({
      residentKey: "required",
      userVerification: "required",
    });

    const authenticator = new SoftwarePasskey("localhost", ORIGIN);
    const registered = await owner
      .post("/api/auth/passkey/verify-registration")
      .set("origin", ORIGIN)
      .send({ response: authenticator.register(registerOptions.body), name: "Laptop" });
    expect(registered.status).toBe(200);

    const list = await owner.get("/api/auth/passkey/list-user-passkeys").set("origin", ORIGIN);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ name: "Laptop", credentialID: authenticator.id });

    const browser = request.agent(app);
    const authenticateOptions = await browser
      .get("/api/auth/passkey/generate-authenticate-options")
      .set("origin", ORIGIN);
    expect(authenticateOptions.status).toBe(200);

    const signedIn = await browser
      .post("/api/auth/passkey/verify-authentication")
      .set("origin", ORIGIN)
      .send({ response: authenticator.authenticate(authenticateOptions.body) });
    expect(signedIn.status).toBe(200);
    expect(signedIn.body?.user?.email).toBe("passkey@example.com");
    expect(cookieNames(signedIn).some((name) => name.includes("session_token"))).toBe(true);

    const [stored] = await db.select().from(authPasskeys).where(eq(authPasskeys.credentialID, authenticator.id));
    expect(stored?.counter).toBe(1);

    const removed = await owner
      .post("/api/auth/passkey/delete-passkey")
      .set("origin", ORIGIN)
      .send({ id: list.body[0].id });
    expect(removed.status).toBe(200);
    expect(await db.select().from(authPasskeys)).toHaveLength(0);
  });

  it("rejects passkey ceremonies the authenticator did not user-verify", async () => {
    const owner = request.agent(app);
    await owner
      .post("/api/auth/sign-up/email")
      .set("origin", ORIGIN)
      .send({ email: "presence-only@example.com", password: PASSWORD, name: "Presence Only" })
      .expect(200);
    const authenticator = new SoftwarePasskey("localhost", ORIGIN);

    const unverifiedOptions = await owner.get("/api/auth/passkey/generate-register-options").set("origin", ORIGIN);
    const unverifiedRegistration = await owner
      .post("/api/auth/passkey/verify-registration")
      .set("origin", ORIGIN)
      .send({ response: authenticator.register(unverifiedOptions.body, { userVerified: false }), name: "Key" });
    expect(unverifiedRegistration.status).toBe(401);
    expect(unverifiedRegistration.body?.code).toBe("PASSKEY_USER_VERIFICATION_REQUIRED");
    expect(await db.select().from(authPasskeys).where(eq(authPasskeys.credentialID, authenticator.id))).toHaveLength(0);

    const registerOptions = await owner.get("/api/auth/passkey/generate-register-options").set("origin", ORIGIN);
    await owner
      .post("/api/auth/passkey/verify-registration")
      .set("origin", ORIGIN)
      .send({ response: authenticator.register(registerOptions.body), name: "Key" })
      .expect(200);

    const browser = request.agent(app);
    const authenticateOptions = await browser
      .get("/api/auth/passkey/generate-authenticate-options")
      .set("origin", ORIGIN);
    const signIn = await browser
      .post("/api/auth/passkey/verify-authentication")
      .set("origin", ORIGIN)
      .send({ response: authenticator.authenticate(authenticateOptions.body, { userVerified: false }) });
    expect(signIn.status).toBe(401);
    expect(signIn.body?.code).toBe("PASSKEY_USER_VERIFICATION_REQUIRED");
    expect(cookieNames(signIn).some((name) => name.includes("session_token"))).toBe(false);
  });
});
