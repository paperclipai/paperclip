import { expect, it } from "vitest";
import {
  validPublicSignInInput,
  publicSignInStorageMatches,
} from "./external-public-signin-contract.js";
const input = () => ({
  receiptPath: "/private/tmp/attempt/public-origin.json",
  executionId: "execution",
  attemptId: "attempt",
  backendOrigin: "http://127.0.0.1:3399",
  publicOrigin: "https://owned.example.test",
  userId: "generated-person",
  email: "mcp-12345678-1234-1234-1234-123456789012@example.test",
  password: "synthetic-generated-private-password",
});
const storage = () => ({
  cookies: [
    {
      name: "session",
      value: "synthetic-private-cookie",
      domain: "owned.example.test",
      path: "/",
      secure: true,
    },
  ],
  origins: [
    {
      origin: "https://owned.example.test",
      localStorage: [{ name: "preference", value: "private-storage-value" }],
    },
  ],
});
it("accepts only generated fixture-person HTTPS sign-in with exact loopback backend and explicit private receipt", () => {
  expect(validPublicSignInInput(input())).toBe(true);
  for (const change of [
    { publicOrigin: "http://owned.example.test" },
    { publicOrigin: "https://user:secret@owned.example.test" },
    { publicOrigin: "https://owned.example.test/auth" },
    { backendOrigin: "http://production.example.test" },
    { email: "someone@real.example" },
    { password: "short" },
    { receiptPath: "relative.json" },
  ])
    expect(validPublicSignInInput({ ...input(), ...change })).toBe(false);
});
it("rejects loopback cookies, broader-domain cookies and another origin's storage", () => {
  expect(publicSignInStorageMatches(storage(), input().publicOrigin)).toBe(
    true,
  );
  for (const change of [
    (s: ReturnType<typeof storage>) => {
      s.cookies[0]!.domain = "127.0.0.1";
    },
    (s: ReturnType<typeof storage>) => {
      s.cookies[0]!.domain = ".example.test";
    },
    (s: ReturnType<typeof storage>) => {
      s.cookies[0]!.secure = false;
    },
    (s: ReturnType<typeof storage>) => {
      s.origins[0]!.origin = "http://127.0.0.1:3399";
    },
    (s: ReturnType<typeof storage>) => {
      s.cookies = [];
    },
  ]) {
    const s = storage();
    change(s);
    expect(publicSignInStorageMatches(s, input().publicOrigin)).toBe(false);
  }
  expect(publicSignInStorageMatches(undefined, input().publicOrigin)).toBe(
    false,
  );
});
