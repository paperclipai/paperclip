import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  BILLING_PAGE_PATH,
  CHECKOUT_PAGE_ROUTE,
  DB_NAMESPACE,
  PLUGIN_ID,
  PROVIDER_STUB,
  STUB_SIGNATURE_HEADER,
  SWEEP_JOB_KEY,
  WEBHOOK_ENDPOINT_KEY,
  WEBHOOK_PATH,
} from "../src/constants.js";

describe("constants", () => {
  it("uses the spec-locked plugin id", () => {
    expect(PLUGIN_ID).toBe("paperclip-plugin-billing");
  });

  it("DB_NAMESPACE matches the host derivation plugin_<slug>_<sha256(id)[0:10]>", () => {
    // Mirrors derivePluginDatabaseNamespace in server/src/services/plugin-database.ts
    const hash = createHash("sha256").update(PLUGIN_ID).digest("hex").slice(0, 10);
    expect(DB_NAMESPACE).toBe(`plugin_billing_${hash}`);
    expect(DB_NAMESPACE).toBe("plugin_billing_d8ffbbf605");
  });

  it("webhook path matches the host route shape", () => {
    expect(WEBHOOK_ENDPOINT_KEY).toBe("provider");
    expect(WEBHOOK_PATH).toBe("/api/plugins/paperclip-plugin-billing/webhooks/provider");
  });

  it("misc keys are stable", () => {
    expect(SWEEP_JOB_KEY).toBe("billing-sweep");
    expect(STUB_SIGNATURE_HEADER).toBe("x-billing-stub-signature");
    expect(BILLING_PAGE_PATH).toBe("/company/settings/billing");
    expect(CHECKOUT_PAGE_ROUTE).toBe("billing-checkout");
    expect(PROVIDER_STUB).toBe("stub");
  });

  it("BILLING_PAGE_PATH is app-relative (leading slash) — regression for the PR-3 standing " +
    "validator (server/src/services/company-standing.ts), which throws badRequest on any " +
    "non-`/`-prefixed, non-http(s) actionUrl", () => {
    expect(BILLING_PAGE_PATH.startsWith("/")).toBe(true);
  });
});
