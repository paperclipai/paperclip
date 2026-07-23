import { describe, expect, it } from "vitest";
import { pluginManifestV1Schema } from "@paperclipai/shared";
import manifest from "../src/manifest.js";
import { CHECKOUT_PAGE_ROUTE, PLUGIN_ID, SWEEP_JOB_KEY, WEBHOOK_ENDPOINT_KEY } from "../src/constants.js";

describe("manifest", () => {
  it("validates against the real shared pluginManifestV1Schema", () => {
    const result = pluginManifestV1Schema.safeParse(manifest);
    expect(result.success, result.success ? undefined : JSON.stringify(result.error.issues)).toBe(true);
  });

  it("declares identity and categories", () => {
    expect(manifest.id).toBe(PLUGIN_ID);
    expect(manifest.apiVersion).toBe(1);
    expect(manifest.categories).toEqual(["automation", "ui"]);
    expect(manifest.entrypoints).toEqual({ worker: "./dist/worker.js", ui: "./dist/ui" });
  });

  it("declares exactly the required capabilities", () => {
    expect([...manifest.capabilities].sort()).toEqual(
      [
        "access.members.read",
        "activity.log.write",
        "api.routes.register",
        "companies.read",
        "company.standing.write",
        "costs.read",
        "database.namespace.migrate",
        "database.namespace.read",
        "database.namespace.write",
        "events.subscribe",
        "http.outbound",
        "instance.settings.register",
        "jobs.schedule",
        "plugin.state.read",
        "plugin.state.write",
        "ui.page.register",
        "webhooks.receive",
      ].sort(),
    );
  });

  it("declares the PR-2 locked-on company enablement", () => {
    expect(manifest.companyEnablement).toEqual({
      default: "on",
      locked: true,
    });
  });

  it("declares database namespace, daily sweep job, and provider webhook", () => {
    expect(manifest.database).toEqual({
      namespaceSlug: "billing",
      migrationsDir: "migrations",
      coreReadTables: ["companies"],
    });
    expect(manifest.jobs).toEqual([
      {
        jobKey: SWEEP_JOB_KEY,
        displayName: "Billing sweep",
        description:
          "Daily reconciliation: creates missing subscription rows, applies time-based transitions, reconciles company standing, cancels subscriptions of deleted companies, replays unapplied ledger events, and delivers due stub-provider events.",
        schedule: "0 4 * * *",
      },
    ]);
    expect(manifest.webhooks).toEqual([
      {
        endpointKey: WEBHOOK_ENDPOINT_KEY,
        displayName: "Billing provider events",
        description: "Signed billing provider events (stub provider in v1). Signature-verified in the worker; unverifiable deliveries change no state.",
      },
    ]);
  });

  it("declares board apiRoutes with company resolution", () => {
    const routes = (manifest.apiRoutes ?? []).map((r) => ({
      routeKey: r.routeKey,
      method: r.method,
      path: r.path,
      auth: r.auth,
      companyResolution: r.companyResolution,
    }));
    expect(routes).toEqual([
      { routeKey: "creation-summary", method: "GET", path: "/creation-summary", auth: "board", companyResolution: { from: "query", key: "companyId" } },
      { routeKey: "summary", method: "GET", path: "/summary", auth: "board", companyResolution: { from: "query", key: "companyId" } },
      { routeKey: "create-checkout", method: "POST", path: "/checkout", auth: "board", companyResolution: { from: "body", key: "companyId" } },
      { routeKey: "resolve-checkout", method: "POST", path: "/checkout/resolve", auth: "board", companyResolution: { from: "body", key: "companyId" } },
      { routeKey: "one-click", method: "POST", path: "/subscribe/one-click", auth: "board", companyResolution: { from: "body", key: "companyId" } },
      { routeKey: "cancel", method: "POST", path: "/cancel", auth: "board", companyResolution: { from: "body", key: "companyId" } },
      { routeKey: "resume", method: "POST", path: "/resume", auth: "board", companyResolution: { from: "body", key: "companyId" } },
      { routeKey: "portal", method: "POST", path: "/portal", auth: "board", companyResolution: { from: "body", key: "companyId" } },
    ]);
    for (const route of manifest.apiRoutes ?? []) {
      expect(route.capability).toBe("api.routes.register");
    }
  });

  it("declares the three UI slots", () => {
    expect(manifest.ui?.slots).toEqual([
      { type: "companySettingsPage", id: "billing-company-page", displayName: "Billing", exportName: "BillingPage", routePath: "billing" },
      { type: "settingsPage", id: "billing-admin-page", displayName: "Billing", exportName: "BillingAdminPage" },
      { type: "page", id: "billing-checkout-page", displayName: "Checkout", exportName: "StubCheckoutPage", routePath: CHECKOUT_PAGE_ROUTE },
    ]);
  });

  it("declares the instance config schema per spec §3", () => {
    const schema = manifest.instanceConfigSchema as {
      type: string;
      properties: Record<string, Record<string, unknown>>;
    };
    expect(schema.type).toBe("object");
    expect(schema.properties.currency).toMatchObject({ type: "string", default: "EUR" });
    expect(schema.properties.defaultMonthlyPriceCents).toMatchObject({ type: "integer", default: 4900, minimum: 0 });
    expect(schema.properties.trialDays).toMatchObject({ type: "integer", default: 7, minimum: 0 });
    expect(schema.properties.graceDays).toMatchObject({ type: "integer", default: 7, minimum: 0 });
    expect(schema.properties.trialPolicy).toMatchObject({
      type: "string",
      enum: ["first-company-per-owner", "every-company", "none"],
      default: "first-company-per-owner",
    });
    expect(schema.properties.provider).toMatchObject({ type: "string", enum: ["stub"], default: "stub" });
    expect(schema.properties.instanceBaseUrl).toMatchObject({
      type: "string",
      default: "http://127.0.0.1:3100",
      "x-paperclip-advanced": true,
    });
  });
});
