import { describe, expect, it } from "vitest";
import {
  DEFAULT_SHOPIFY_ROUTER_CONFIG,
  type ShopifyRouterConfig,
} from "./shopify-skill-router.config.js";
import { routeShopifySkillKeys } from "./shopify-skill-router.js";

const SHOPIFY_PREFIX = "shopify/shopify-ai-toolkit/";

function toSuffixes(keys: string[]) {
  return keys.map((key) => key.replace(SHOPIFY_PREFIX, ""));
}

function route(input: Partial<Parameters<typeof routeShopifySkillKeys>[0]>) {
  return routeShopifySkillKeys({
    issueTitle: "",
    issueDescription: null,
    commentBodies: [],
    ancestorTitles: [],
    agentRole: null,
    agentCapabilities: null,
    goalTitle: null,
    projectTags: [],
    ...input,
  });
}

describe("routeShopifySkillKeys", () => {
  it("routes Liquid theme work to the Liquid skill", () => {
    const output = route({
      issueTitle: "Storefront product page Liquid bug",
      issueDescription: "Fix infinite loop in product-card.liquid section schema.",
    });

    expect(toSuffixes(output.skillKeys)).toEqual(["shopify-dev", "shopify-liquid"]);
    expect(output.gated).toBe(false);
  });

  it("routes Admin GraphQL work to the admin skill", () => {
    const output = route({
      issueTitle: "Build mutation to bulk-update product tags",
      issueDescription: "Admin GraphQL mutation, no CLI.",
    });

    expect(toSuffixes(output.skillKeys)).toEqual(["shopify-dev", "shopify-admin"]);
    expect(output.gated).toBe(false);
  });

  it("routes Shopify CLI execution work to the CLI skill as well", () => {
    const output = route({
      issueTitle: "Bulk-update product tags via Shopify CLI",
      issueDescription: "Use shopify store execute to run the admin mutation.",
    });

    expect(toSuffixes(output.skillKeys)).toEqual([
      "shopify-dev",
      "shopify-admin",
      "shopify-use-shopify-cli",
    ]);
    expect(output.gated).toBe(false);
  });

  it("routes checkout extension work to functions and checkout UI extensions", () => {
    const output = route({
      issueTitle: "Add custom shipping note to Shopify checkout",
      issueDescription: "Checkout UI block + cart transform function.",
    });

    expect(toSuffixes(output.skillKeys)).toEqual([
      "shopify-dev",
      "shopify-functions",
      "shopify-polaris-checkout-extensions",
    ]);
    expect(output.gated).toBe(false);
  });

  it("gates unrelated work out", () => {
    const output = route({
      issueTitle: "Audit Firebase usage",
      issueDescription: "Unrelated infra cleanup.",
    });

    expect(output.skillKeys).toEqual([]);
    expect(output.gated).toBe(true);
  });

  it("routes Hydrogen and custom data work together", () => {
    const output = route({
      issueTitle: "Hydrogen + Metaobjects",
      issueDescription: "Dynamic content with metaobjects in Hydrogen storefront.",
    });

    expect(toSuffixes(output.skillKeys)).toEqual([
      "shopify-dev",
      "shopify-hydrogen",
      "shopify-custom-data",
    ]);
    expect(output.gated).toBe(false);
  });

  it("caps the routed skill list while keeping the baseline skill", () => {
    const output = route({
      issueTitle: "Shopify theme checkout customer account hydrogen metafield POS payment provider",
      issueDescription:
        "Use Admin GraphQL and Shopify CLI for a cart transform in Hydrogen while updating custom data.",
    });

    expect(output.skillKeys).toHaveLength(5);
    expect(toSuffixes(output.skillKeys)).toContain("shopify-dev");
    expect(toSuffixes(output.skillKeys)).toEqual([
      "shopify-dev",
      "shopify-liquid",
      "shopify-functions",
      "shopify-polaris-checkout-extensions",
      "shopify-admin",
    ]);
    expect(output.gated).toBe(false);
  });

  it("fires the Shopify gate from project tags alone", () => {
    const output = route({
      issueTitle: "Triage routing issue",
      issueDescription: "Need help with task routing.",
      projectTags: ["shopify"],
    });

    expect(toSuffixes(output.skillKeys)).toEqual(["shopify-dev"]);
    expect(output.gated).toBe(false);
  });

  it("honors config declaration order when priorities tie", () => {
    const config: ShopifyRouterConfig = {
      ...DEFAULT_SHOPIFY_ROUTER_CONFIG,
      baselineSkillKey: `${SHOPIFY_PREFIX}shopify-dev`,
      cap: 4,
    };

    const output = routeShopifySkillKeys({
      issueTitle: "Checkout theme admin graphQL",
      issueDescription: null,
      commentBodies: [],
      ancestorTitles: [],
      agentRole: null,
      agentCapabilities: null,
      goalTitle: null,
      projectTags: [],
    }, config);

    expect(toSuffixes(output.skillKeys).slice(0, 4)).toEqual([
      "shopify-dev",
      "shopify-liquid",
      "shopify-functions",
      "shopify-polaris-checkout-extensions",
    ]);
  });
});
