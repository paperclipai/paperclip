import React from "react";
import { usePluginData } from "@paperclipai/plugin-sdk/ui";

// ─── Shared styles ────────────────────────────────────────────────────────────

const styles = {
  card: {
    background: "#fff",
    border: "1px solid #e5e7eb",
    borderRadius: 8,
    padding: "16px 20px",
    marginBottom: 12,
  } as React.CSSProperties,
  badge: (ok: boolean): React.CSSProperties => ({
    display: "inline-block",
    padding: "2px 8px",
    borderRadius: 12,
    fontSize: 12,
    fontWeight: 600,
    background: ok ? "#d1fae5" : "#fee2e2",
    color: ok ? "#065f46" : "#991b1b",
    marginLeft: 6,
  }),
  pre: {
    background: "#f9fafb",
    border: "1px solid #e5e7eb",
    borderRadius: 6,
    padding: 12,
    fontSize: 13,
    whiteSpace: "pre-wrap" as const,
    overflowX: "auto" as const,
    maxHeight: 400,
    overflow: "auto",
  } as React.CSSProperties,
};

// ─── Types ────────────────────────────────────────────────────────────────────

type CachedDeals = {
  fetchedAt: string | null;
  weeklyAdText: string;
  productCount: number;
};

type ConfigStatus = {
  hasBearerToken: boolean;
  hasCookieAuth: boolean;
  storeNumber: string | null;
  shoppingContext: string;
};

// ─── Deals Widget (dashboard) ─────────────────────────────────────────────────

export function DealsWidget() {
  const { data: deals, loading } = usePluginData<CachedDeals>("cached-deals");

  if (loading) return <div style={{ padding: 16, color: "#6b7280" }}>Loading HEB deals…</div>;

  return (
    <div style={{ padding: 16 }}>
      <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 8 }}>🛒 HEB Weekly Deals</div>
      {deals?.fetchedAt ? (
        <>
          <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 12 }}>
            {deals.productCount} items · last refreshed {new Date(deals.fetchedAt).toLocaleString()}
          </div>
          <div style={styles.pre}>
            {deals.weeklyAdText.slice(0, 1500)}
            {deals.weeklyAdText.length > 1500 ? "\n…(see full HEB Grocery page)" : ""}
          </div>
        </>
      ) : (
        <div style={{ color: "#6b7280", fontSize: 14 }}>
          No deals cached yet. The daily refresh runs at 7 AM once credentials are configured.
        </div>
      )}
    </div>
  );
}

// ─── Full Grocery Page ────────────────────────────────────────────────────────

export function GroceryPage() {
  const { data: status } = usePluginData<ConfigStatus>("config-status");
  const { data: deals, loading: dealsLoading } = usePluginData<CachedDeals>("cached-deals");

  return (
    <div style={{ maxWidth: 720, margin: "0 auto", padding: 24 }}>
      <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 4 }}>🛒 HEB Grocery</h1>
      <p style={{ color: "#6b7280", marginBottom: 24, fontSize: 14 }}>
        HEB API harness for agents. Configure credentials in plugin settings, then use agent tools
        to search products, view deals, manage your cart, and more.
      </p>

      {/* Auth Status */}
      <div style={styles.card}>
        <div style={{ fontWeight: 600, marginBottom: 12 }}>Connection Status</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 14 }}>
          <div>
            Bearer auth (products / search / orders)
            <span style={styles.badge(Boolean(status?.hasBearerToken))}>
              {status?.hasBearerToken ? "configured" : "not set"}
            </span>
          </div>
          <div>
            Cookie auth (cart / shopping lists)
            <span style={styles.badge(Boolean(status?.hasCookieAuth))}>
              {status?.hasCookieAuth ? "configured" : "not set"}
            </span>
          </div>
          <div>
            Store
            <span style={{ marginLeft: 8, fontWeight: 600 }}>
              {status?.storeNumber ?? <em style={{ color: "#6b7280" }}>not set</em>}
            </span>
          </div>
          <div>
            Shopping context
            <span style={{ marginLeft: 8, fontWeight: 600 }}>
              {status?.shoppingContext ?? "EXPLORE_MY_STORE"}
            </span>
          </div>
        </div>
      </div>

      {/* Available Tools */}
      <div style={styles.card}>
        <div style={{ fontWeight: 600, marginBottom: 12 }}>Available Agent Tools</div>
        <ul style={{ margin: 0, paddingLeft: 20, fontSize: 14, lineHeight: 1.8 }}>
          <li>
            <code>heb_search_products</code> — search the HEB catalog
          </li>
          <li>
            <code>heb_get_weekly_ad</code> — current sale items &amp; deals
          </li>
          <li>
            <code>heb_get_coupons</code> — available digital coupons
          </li>
          <li>
            <code>heb_get_cart</code> — view cart contents
          </li>
          <li>
            <code>heb_add_to_cart</code> — add a product by ID
          </li>
          <li>
            <code>heb_get_order_history</code> — past orders
          </li>
          <li>
            <code>heb_get_account</code> — account &amp; loyalty info
          </li>
          <li>
            <code>heb_product_details</code> — full product info incl. nutrition
          </li>
        </ul>
      </div>

      {/* Cached Weekly Ad */}
      <div style={styles.card}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Cached Weekly Ad</div>
        {dealsLoading ? (
          <div style={{ color: "#6b7280", fontSize: 14 }}>Loading…</div>
        ) : deals?.fetchedAt ? (
          <>
            <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 8 }}>
              {deals.productCount} items · refreshed{" "}
              {new Date(deals.fetchedAt).toLocaleString()}
            </div>
            <div style={styles.pre}>{deals.weeklyAdText}</div>
          </>
        ) : (
          <div style={{ color: "#6b7280", fontSize: 14 }}>
            No deals cached yet. The daily job runs at 7 AM, or configure credentials and trigger a
            manual refresh via the agent.
          </div>
        )}
      </div>

      {/* Setup Instructions */}
      <div style={styles.card}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Setup Guide</div>
        <ol style={{ margin: 0, paddingLeft: 20, fontSize: 13, lineHeight: 2, color: "#374151" }}>
          <li>
            Open <strong>Plugin Settings → HEB Grocery</strong>
          </li>
          <li>
            Set your <strong>Store Number</strong> (find it on heb.com/store-locations)
          </li>
          <li>
            For bearer auth: log into the HEB mobile app with a proxy (e.g. Charles/mitmproxy),
            capture an API call, and copy the <code>Authorization: Bearer …</code> token
          </li>
          <li>
            For cookie auth: log into heb.com, open DevTools → Network → any{" "}
            <code>/graphql</code> request, copy the full <code>Cookie</code> header value and
            split out <code>sat=…</code> and <code>reese84=…</code>
          </li>
          <li>Save settings — the daily deal refresh will run at 7 AM automatically</li>
        </ol>
      </div>
    </div>
  );
}
