import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "paperclipai.plugin-heb-grocery",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "HEB Grocery",
  description:
    "Connects to H-E-B's APIs to track deals, coupons, weekly ad products, cart, and order history.",
  author: "Paperclip",
  categories: ["connector", "automation"],
  capabilities: [
    "plugin.state.read",
    "plugin.state.write",
    "secrets.read-ref",
    "jobs.schedule",
    "http.outbound",
    "agent.tools.register",
    "instance.settings.register",
    "ui.dashboardWidget.register",
    "ui.page.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      storeNumber: {
        type: "string",
        title: "HEB Store Number",
        description:
          "Your preferred H-E-B store number (e.g. '790'). Find it in the URL when browsing heb.com.",
        default: "",
      },
      shoppingContext: {
        type: "string",
        title: "Shopping Context",
        description: "Default shopping mode.",
        enum: ["CURBSIDE_PICKUP", "CURBSIDE_DELIVERY", "EXPLORE_MY_STORE"],
        default: "EXPLORE_MY_STORE",
      },
      hebAccessToken: {
        type: "string",
        title: "HEB Access Token (Bearer)",
        description:
          "OAuth access token from the HEB mobile app. Required for product search, weekly ad, orders, and account info.",
        default: "",
      },
      hebRefreshToken: {
        type: "string",
        title: "HEB Refresh Token",
        description: "OAuth refresh token used to get new access tokens automatically.",
        default: "",
      },
      hebIdToken: {
        type: "string",
        title: "HEB ID Token",
        description: "JWT ID token from HEB's OIDC server containing your profile.",
        default: "",
      },
      hebSatCookie: {
        type: "string",
        title: "HEB SAT Cookie",
        description:
          "Session Authentication Token cookie from heb.com. Required for cart and shopping list operations.",
        default: "",
      },
      hebReese84Cookie: {
        type: "string",
        title: "HEB Reese84 Cookie",
        description:
          "Imperva bot-mitigation fingerprint cookie from heb.com. Must be kept fresh via a browser session.",
        default: "",
      },
    },
  },
  jobs: [
    {
      jobKey: "daily-deals-refresh",
      displayName: "Daily Deals Refresh",
      description:
        "Fetches the current weekly ad and caches it each morning so agents have fresh deal data without hitting the API on every question.",
      schedule: "0 7 * * *",
    },
  ],
  tools: [
    {
      name: "heb_search_products",
      displayName: "HEB: Search Products",
      description:
        "Search for products at H-E-B. Returns matching products with names, prices, and availability.",
      parametersSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search term, e.g. 'coffee' or 'organic milk'" },
          limit: {
            type: "number",
            description: "Max results to return (default 10, max 50)",
            default: 10,
          },
        },
        required: ["query"],
      },
    },
    {
      name: "heb_get_weekly_ad",
      displayName: "HEB: Get Weekly Ad",
      description:
        "Returns the current weekly ad deals and sale items at the configured HEB store.",
      parametersSchema: {
        type: "object",
        properties: {
          categoryId: {
            type: "string",
            description: "Optional category filter ID to narrow to a specific ad section.",
          },
          limit: {
            type: "number",
            description: "Max products to return (default 20)",
            default: 20,
          },
        },
      },
    },
    {
      name: "heb_get_coupons",
      displayName: "HEB: Get Available Coupons",
      description:
        "Returns the cached list of available HEB digital coupons fetched during the last daily refresh.",
      parametersSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Optional search term to filter coupons by product name.",
          },
        },
      },
    },
    {
      name: "heb_get_cart",
      displayName: "HEB: Get Cart",
      description: "Returns the current items in the HEB cart along with subtotal and savings.",
      parametersSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "heb_add_to_cart",
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
    {
      name: "heb_get_order_history",
      displayName: "HEB: Get Order History",
      description: "Returns recent HEB orders including dates, totals, and item counts.",
      parametersSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Number of recent orders to return (default 5)", default: 5 },
        },
      },
    },
    {
      name: "heb_get_account",
      displayName: "HEB: Get Account Details",
      description: "Returns HEB account profile, loyalty number, and saved addresses.",
      parametersSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "heb_product_details",
      displayName: "HEB: Get Product Details",
      description:
        "Returns full details for a specific HEB product including nutrition info, ingredients, and fulfillment options.",
      parametersSchema: {
        type: "object",
        properties: {
          productId: { type: "string", description: "HEB product ID" },
        },
        required: ["productId"],
      },
    },
  ],
  ui: {
    slots: [
      {
        type: "page",
        id: "heb-grocery-page",
        displayName: "HEB Grocery",
        exportName: "GroceryPage",
        routePath: "heb-grocery",
      },
      {
        type: "dashboardWidget",
        id: "heb-deals-widget",
        displayName: "HEB Today's Deals",
        exportName: "DealsWidget",
      },
    ],
  },
};

export default manifest;
