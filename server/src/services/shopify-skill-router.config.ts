export interface ShopifyRouterRule {
  id: string;
  pattern: RegExp;
  skillKeys: string[];
  priority: number;
}

export interface ShopifyRouterConfig {
  gateRegex: RegExp;
  baselineSkillKey: string;
  rules: ShopifyRouterRule[];
  cap: number;
}

const SHOPIFY_SKILL_PREFIX = "shopify/shopify-ai-toolkit";

function shopifySkillKey(slug: string) {
  return `${SHOPIFY_SKILL_PREFIX}/${slug}`;
}

export const DEFAULT_SHOPIFY_ROUTER_CONFIG: ShopifyRouterConfig = {
  gateRegex: /(shopify|merchant\s+store|liquid|hydrogen|polaris|admin\s+graphql|storefront|metafield|metaobject)/i,
  baselineSkillKey: shopifySkillKey("shopify-dev"),
  rules: [
    {
      id: "liquid",
      pattern: /liquid|\btheme\b|section|snippet|schema\.json/i,
      skillKeys: [shopifySkillKey("shopify-liquid")],
      priority: 10,
    },
    {
      id: "checkout",
      pattern: /checkout|\bcart\b|payment\s+customization|delivery\s+customization|cart\s+transform/i,
      skillKeys: [
        shopifySkillKey("shopify-functions"),
        shopifySkillKey("shopify-polaris-checkout-extensions"),
      ],
      priority: 10,
    },
    {
      id: "admin-graphql",
      pattern: /admin\s+graphql|admin\s+api|admin\s+mutation|admin\s+query/i,
      skillKeys: [shopifySkillKey("shopify-admin")],
      priority: 10,
    },
    {
      id: "admin-cli",
      pattern: /shopify\s+cli|shopify\s+store\s+execute|shopify\s+store\s+auth/i,
      skillKeys: [shopifySkillKey("shopify-use-shopify-cli")],
      priority: 8,
    },
    {
      id: "custom-data",
      pattern: /metafield|metaobject|custom\s+data/i,
      skillKeys: [shopifySkillKey("shopify-custom-data")],
      priority: 9,
    },
    {
      id: "hydrogen",
      pattern: /hydrogen/i,
      skillKeys: [shopifySkillKey("shopify-hydrogen")],
      priority: 10,
    },
    {
      id: "polaris-app",
      pattern: /polaris|app\s+home|embedded\s+admin/i,
      skillKeys: [shopifySkillKey("shopify-polaris-app-home")],
      priority: 7,
    },
    {
      id: "admin-ext",
      pattern: /admin\s+(ui\s+)?extension|admin\s+block|smart\s+grid\s+admin/i,
      skillKeys: [shopifySkillKey("shopify-polaris-admin-extensions")],
      priority: 9,
    },
    {
      id: "pos",
      pattern: /\bpos\b|retail|point\s+of\s+sale|smart\s+grid/i,
      skillKeys: [shopifySkillKey("shopify-pos-ui")],
      priority: 9,
    },
    {
      id: "storefront-gql",
      pattern: /storefront\s+graphql|storefront\s+api|<shopify-store>|<shopify-cart>/i,
      skillKeys: [shopifySkillKey("shopify-storefront-graphql")],
      priority: 9,
    },
    {
      id: "customer-account",
      pattern: /customer\s+account/i,
      skillKeys: [
        shopifySkillKey("shopify-customer"),
        shopifySkillKey("shopify-polaris-customer-account-extensions"),
      ],
      priority: 9,
    },
    {
      id: "partner",
      pattern: /partner\s+api|partner\s+dashboard/i,
      skillKeys: [shopifySkillKey("shopify-partner")],
      priority: 7,
    },
    {
      id: "payments-app",
      pattern: /payments\s+app|payment\s+provider|payment\s+gateway/i,
      skillKeys: [shopifySkillKey("shopify-payments-apps")],
      priority: 8,
    },
    {
      id: "app-review",
      pattern: /app\s+store\s+review|submission|app\s+store\s+compliance/i,
      skillKeys: [shopifySkillKey("shopify-app-store-review")],
      priority: 7,
    },
    {
      id: "onboarding-merchant",
      pattern: /merchant\s+onboarding|migrate\s+from\s+(square|woocommerce|etsy|amazon|ebay|wix|clover|lightspeed)|set\s+up\s+my\s+store/i,
      skillKeys: [shopifySkillKey("shopify-onboarding-merchant")],
      priority: 8,
    },
    {
      id: "onboarding-dev",
      pattern: /dev\s+store|partner\s+account|scaffold\s+(an\s+)?app|new\s+app\s+template/i,
      skillKeys: [shopifySkillKey("shopify-onboarding-dev")],
      priority: 7,
    },
  ],
  cap: 5,
};
