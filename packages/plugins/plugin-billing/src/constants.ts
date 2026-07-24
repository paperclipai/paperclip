export const PLUGIN_ID = "paperclip-plugin-billing";

/**
 * Host-derived Postgres schema for this plugin:
 * plugin_<namespaceSlug>_<sha256(PLUGIN_ID).hex.slice(0, 10)>
 * (server/src/services/plugin-database.ts). namespaceSlug is "billing".
 */
export const DB_NAMESPACE = "plugin_billing_d8ffbbf605";

export const WEBHOOK_ENDPOINT_KEY = "provider";
export const WEBHOOK_PATH = `/api/plugins/${PLUGIN_ID}/webhooks/${WEBHOOK_ENDPOINT_KEY}`;

export const SWEEP_JOB_KEY = "billing-sweep";

/** Header carrying the hex HMAC-SHA256 of the raw stub event body. */
export const STUB_SIGNATURE_HEADER = "x-billing-stub-signature";

/**
 * App-relative path of the plugin's Billing company-settings page.
 * Must keep the leading slash: the PR-3 standing validator
 * (server/src/services/company-standing.ts) rejects non-`/`-prefixed
 * relative actionUrls.
 */
export const BILLING_PAGE_PATH = "/company/settings/billing";

/** routePath of the stub checkout simulator `page` slot (mounted at /:companyPrefix/billing-checkout). */
export const CHECKOUT_PAGE_ROUTE = "billing-checkout";

export const PROVIDER_STUB = "stub";
