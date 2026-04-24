import {
  createTokenSession,
  createSessionFromCookies,
  HEBClient,
  getWeeklyAdProducts,
  getAccountDetails,
  getOrders,
  getCart,
  getProductDetails,
  searchProducts,
  persistedQuery,
  addToCart,
  formatWeeklyAd,
  formatOrderHistory,
  formatCart,
  formatAccountDetails,
  formatProductDetails,
  setStore,
  type HEBSession,
  type RawHistoryOrder,
} from "heb-sdk-unofficial";
import {
  definePlugin,
  runWorker,
  type PluginContext,
  type ToolRunContext,
  type ToolResult,
} from "@paperclipai/plugin-sdk";

// ─── Types ────────────────────────────────────────────────────────────────────

type HEBConfig = {
  storeNumber?: string;
  shoppingContext?: "CURBSIDE_PICKUP" | "CURBSIDE_DELIVERY" | "EXPLORE_MY_STORE";
  hebAccessToken?: string;
  hebRefreshToken?: string;
  hebIdToken?: string;
  hebSatCookie?: string;
  hebReese84Cookie?: string;
};

type CachedDeals = {
  fetchedAt: string;
  weeklyAdText: string;
  productCount: number;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function getConfig(ctx: PluginContext): Promise<HEBConfig> {
  const raw = await ctx.config.get();
  return (raw ?? {}) as HEBConfig;
}

/**
 * Build a bearer (mobile) session from config.
 * Throws a clear message when tokens are not configured.
 */
function buildBearerSession(cfg: HEBConfig): HEBSession {
  if (!cfg.hebAccessToken) {
    throw new Error(
      "HEB bearer token not configured. Set 'hebAccessToken' in the HEB Grocery plugin settings."
    );
  }
  return createTokenSession({
    accessToken: cfg.hebAccessToken,
    refreshToken: cfg.hebRefreshToken,
    idToken: cfg.hebIdToken,
    expiresIn: 1800,
  });
}

/**
 * Build a cookie (web) session. Throws if SAT cookie is missing.
 */
function buildCookieSession(cfg: HEBConfig): HEBSession {
  if (!cfg.hebSatCookie) {
    throw new Error(
      "HEB SAT cookie not configured. Set 'hebSatCookie' in the HEB Grocery plugin settings."
    );
  }
  const parts = [`sat=${cfg.hebSatCookie}`];
  if (cfg.hebReese84Cookie) parts.push(`reese84=${cfg.hebReese84Cookie}`);
  if (cfg.storeNumber) parts.push(`CURR_SESSION_STORE=${cfg.storeNumber}`);
  return createSessionFromCookies(parts.join("; "));
}

function summarizeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info("HEB Grocery plugin starting up");

    // ── Scheduled job: daily deals refresh ──────────────────────────────────
    ctx.jobs.register("daily-deals-refresh", async (_jobCtx) => {
      ctx.logger.info("Running daily HEB deals refresh");
      try {
        const cfg = await getConfig(ctx);
        const session = buildBearerSession(cfg);
        if (cfg.storeNumber) await setStore(session, cfg.storeNumber);
        const ad = await getWeeklyAdProducts(session, { limit: 100 });
        const text = formatWeeklyAd(ad);
        const cached: CachedDeals = {
          fetchedAt: new Date().toISOString(),
          weeklyAdText: text,
          productCount: ad.products.length,
        };
        await ctx.state.set(
          { scopeKind: "instance", stateKey: "weekly-ad" },
          cached
        );
        ctx.logger.info(`Cached ${ad.products.length} weekly ad products`);
      } catch (err) {
        ctx.logger.error("Failed to refresh HEB deals", { error: summarizeError(err) });
        throw err;
      }
    });

    // ── Tools ────────────────────────────────────────────────────────────────

    ctx.tools.register(
      "heb_search_products",
      {
        displayName: "HEB: Search Products",
        description: "Search for products at H-E-B. Returns matching products with names, prices, and availability.",
        parametersSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search term, e.g. 'coffee' or 'organic milk'" },
            limit: { type: "number", description: "Max results to return (default 10, max 50)", default: 10 },
          },
          required: ["query"],
        },
      },
      async (params, _runCtx: ToolRunContext): Promise<ToolResult> => {
        const { query, limit = 10 } = params as { query: string; limit?: number };
        try {
          const cfg = await getConfig(ctx);
          const session = buildBearerSession(cfg);
          if (cfg.storeNumber) await setStore(session, cfg.storeNumber);
          const results = await searchProducts(session, query, { limit: Math.min(limit, 50) });
          if (results.products.length === 0) {
            return { content: `No products found for "${query}".` };
          }
          const lines = results.products.map((p, i) => {
            const price = p.price ? p.price.formatted : "price unavailable";
            const brand = p.brand ? ` (${p.brand})` : "";
            return `${i + 1}. **${p.name}**${brand} — ${price} | ID: \`${p.productId}\``;
          });
          return {
            content: `**HEB Product Search: "${query}"** (${results.totalCount} total)\n\n${lines.join("\n")}`,
          };
        } catch (err) {
          return { error: `Error searching HEB products: ${summarizeError(err)}` };
        }
      }
    );

    ctx.tools.register(
      "heb_get_weekly_ad",
      {
        displayName: "HEB: Get Weekly Ad",
        description: "Returns the current weekly ad deals and sale items at the configured HEB store.",
        parametersSchema: {
          type: "object",
          properties: {
            category: { type: "string", description: "Optional category filter ID to narrow to a specific ad section." },
            limit: { type: "number", description: "Max products to return (default 20)", default: 20 },
          },
        },
      },
      async (params, _runCtx: ToolRunContext): Promise<ToolResult> => {
        const { category, limit = 20 } = (params ?? {}) as { category?: string; limit?: number };
        try {
          // Return cache when no category filter requested
          if (!category) {
            const cached = await ctx.state.get({
              scopeKind: "instance",
              stateKey: "weekly-ad",
            }) as CachedDeals | null;
            if (cached) {
              const ageHours = Math.round(
                (Date.now() - new Date(cached.fetchedAt).getTime()) / 3600000
              );
              return {
                content: `**HEB Weekly Ad** (cached ${ageHours}h ago, ${cached.productCount} items)\n\n${cached.weeklyAdText}`,
              };
            }
          }
          // Fetch fresh
          const cfg = await getConfig(ctx);
          const session = buildBearerSession(cfg);
          if (cfg.storeNumber) await setStore(session, cfg.storeNumber);
          const ad = await getWeeklyAdProducts(session, {
            limit: Math.min(limit, 100),
            ...(category ? { category } : {}),
          });
          return { content: formatWeeklyAd(ad) };
        } catch (err) {
          return { error: `Error fetching HEB weekly ad: ${summarizeError(err)}` };
        }
      }
    );

    ctx.tools.register(
      "heb_get_coupons",
      {
        displayName: "HEB: Get Available Coupons",
        description: "Returns available HEB digital coupons, optionally filtered by product name.",
        parametersSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Optional search term to filter coupons by product name." },
          },
        },
      },
      async (params, _runCtx: ToolRunContext): Promise<ToolResult> => {
        const { query } = (params ?? {}) as { query?: string };
        try {
          const cfg = await getConfig(ctx);
          const session = buildBearerSession(cfg);
          const variables: Record<string, unknown> = { first: 50, sortBy: "RELEVANCE" };
          if (query) variables["searchTerm"] = query;

          let result: unknown;
          try {
            result = await persistedQuery(session, "searchCouponsV2", variables);
          } catch {
            result = await persistedQuery(session, "couponSummary", {});
          }
          const header = query ? `**HEB Coupons matching "${query}"**` : "**HEB Available Coupons**";
          return { content: `${header}\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\`` };
        } catch (err) {
          return { error: `Error fetching HEB coupons: ${summarizeError(err)}` };
        }
      }
    );

    ctx.tools.register(
      "heb_get_cart",
      {
        displayName: "HEB: Get Cart",
        description: "Returns the current items in the HEB cart along with subtotal and savings.",
        parametersSchema: { type: "object", properties: {} },
      },
      async (_params, _runCtx: ToolRunContext): Promise<ToolResult> => {
        try {
          const cfg = await getConfig(ctx);
          const session = buildCookieSession(cfg);
          const cart = await getCart(session);
          return { content: formatCart(cart) };
        } catch (err) {
          return { error: `Error fetching HEB cart: ${summarizeError(err)}` };
        }
      }
    );

    ctx.tools.register(
      "heb_add_to_cart",
      {
        displayName: "HEB: Add to Cart",
        description: "Adds a product to the HEB cart by product ID and quantity.",
        parametersSchema: {
          type: "object",
          properties: {
            productId: { type: "string", description: "HEB product ID" },
            quantity: { type: "number", description: "Quantity to set (replaces existing quantity)" },
          },
          required: ["productId", "quantity"],
        },
      },
      async (params, _runCtx: ToolRunContext): Promise<ToolResult> => {
        const { productId, quantity } = params as { productId: string; quantity: number };
        try {
          const cfg = await getConfig(ctx);
          const session = buildBearerSession(cfg);
          if (cfg.storeNumber) await setStore(session, cfg.storeNumber);
          const product = await getProductDetails(session, productId);
          const skuId = product.skuId ?? productId;
          const result = await addToCart(session, productId, skuId, quantity);
          const itemCount = result.cart?.itemCount ?? "?";
          return {
            content: `Added ${quantity}× **${product.name}** to cart. Cart now has ${itemCount} item(s).`,
          };
        } catch (err) {
          return { error: `Error adding to HEB cart: ${summarizeError(err)}` };
        }
      }
    );

    ctx.tools.register(
      "heb_get_order_history",
      {
        displayName: "HEB: Get Order History",
        description: "Returns recent HEB orders including dates, totals, and item counts.",
        parametersSchema: {
          type: "object",
          properties: {
            page: { type: "number", description: "Page number (default 1)", default: 1 },
            size: { type: "number", description: "Orders per page (default 5)", default: 5 },
          },
        },
      },
      async (params, _runCtx: ToolRunContext): Promise<ToolResult> => {
        const { page = 1, size = 5 } = (params ?? {}) as { page?: number; size?: number };
        try {
          const cfg = await getConfig(ctx);
          const session = buildBearerSession(cfg);
          const response = await getOrders(session, { page, size: Math.min(size, 20) });
          const orders: RawHistoryOrder[] = response.pageProps?.orders ?? [];
          return { content: formatOrderHistory(orders) };
        } catch (err) {
          return { error: `Error fetching HEB order history: ${summarizeError(err)}` };
        }
      }
    );

    ctx.tools.register(
      "heb_get_account",
      {
        displayName: "HEB: Get Account Details",
        description: "Returns HEB account profile, loyalty number, and saved addresses.",
        parametersSchema: { type: "object", properties: {} },
      },
      async (_params, _runCtx: ToolRunContext): Promise<ToolResult> => {
        try {
          const cfg = await getConfig(ctx);
          const session = buildBearerSession(cfg);
          const account = await getAccountDetails(session);
          return { content: formatAccountDetails(account) };
        } catch (err) {
          return { error: `Error fetching HEB account: ${summarizeError(err)}` };
        }
      }
    );

    ctx.tools.register(
      "heb_product_details",
      {
        displayName: "HEB: Get Product Details",
        description: "Returns full details for a specific HEB product including nutrition info and fulfillment options.",
        parametersSchema: {
          type: "object",
          properties: {
            productId: { type: "string", description: "HEB product ID" },
          },
          required: ["productId"],
        },
      },
      async (params, _runCtx: ToolRunContext): Promise<ToolResult> => {
        const { productId } = params as { productId: string };
        try {
          const cfg = await getConfig(ctx);
          const session = buildBearerSession(cfg);
          if (cfg.storeNumber) await setStore(session, cfg.storeNumber);
          const product = await getProductDetails(session, productId);
          return { content: formatProductDetails(product) };
        } catch (err) {
          return { error: `Error fetching HEB product details: ${summarizeError(err)}` };
        }
      }
    );

    // ── Data endpoints for UI ────────────────────────────────────────────────

    ctx.data.register("cached-deals", async () => {
      const cached = await ctx.state.get({
        scopeKind: "instance",
        stateKey: "weekly-ad",
      }) as CachedDeals | null;
      return cached ?? {
        fetchedAt: null,
        weeklyAdText: "No data yet. Wait for the daily 7 AM refresh or configure credentials.",
        productCount: 0,
      };
    });

    ctx.data.register("config-status", async () => {
      const cfg = await getConfig(ctx);
      return {
        hasBearerToken: Boolean(cfg.hebAccessToken),
        hasCookieAuth: Boolean(cfg.hebSatCookie),
        storeNumber: cfg.storeNumber ?? null,
        shoppingContext: cfg.shoppingContext ?? "EXPLORE_MY_STORE",
      };
    });

    ctx.logger.info("HEB Grocery plugin ready");
  },

  async onHealth() {
    return { status: "ok", message: "HEB Grocery plugin worker is running" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
