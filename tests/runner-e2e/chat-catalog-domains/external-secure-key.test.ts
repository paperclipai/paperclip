import { expect, it } from "vitest";
import { secureProviderFacts } from "./external-secure-key.js";

it("supplies only the actual nonsecret selected account/origin, never a route or setup recipe", () => {
  const body = secureProviderFacts("http://127.0.0.1:4321/");
  expect(body).toContain("Synthetic notes service (controlled test provider)");
  expect(body).toContain("Authorized server origin: http://127.0.0.1:4321");
  expect(body).not.toMatch(/API key|password|credential|Check link|\/apps|launch_read|launch_update|tools\/call|ready|secret_ref/i);
  for (const wrong of ["https://provider.invalid/", "http://127.0.0.1:4321/recipe", "http://user:key@127.0.0.1:4321/", "http://127.0.0.1:4321/?key=private", "http://127.0.0.1:4321/#private"])
    expect(() => secureProviderFacts(wrong)).toThrow("actual owned provider origin");
});
