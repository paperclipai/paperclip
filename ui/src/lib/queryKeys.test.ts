import { describe, it, expect } from "vitest";
import { queryKeys } from "./queryKeys";

describe("queryKeys", () => {
  // ---------------------------------------------------------------------------
  // plugins (added in feature/plugins)
  // ---------------------------------------------------------------------------
  describe("plugins", () => {
    it("plugins.all returns a stable key array", () => {
      expect(queryKeys.plugins.all).toEqual(["plugins"]);
    });

    it("plugins.detail returns key including pluginId", () => {
      expect(queryKeys.plugins.detail("p1")).toEqual(["plugins", "p1"]);
      expect(queryKeys.plugins.detail("acme.test")).toEqual(["plugins", "acme.test"]);
    });

    it("plugins.detail with different ids returns different keys", () => {
      const k1 = queryKeys.plugins.detail("p1");
      const k2 = queryKeys.plugins.detail("p2");
      expect(k1).not.toEqual(k2);
    });

    it("plugins.health returns key including pluginId and 'health' segment", () => {
      expect(queryKeys.plugins.health("p1")).toEqual(["plugins", "p1", "health"]);
      expect(queryKeys.plugins.health("acme.test")).toEqual(["plugins", "acme.test", "health"]);
    });

    it("plugins.health and plugins.detail have distinct keys for same id", () => {
      const detail = queryKeys.plugins.detail("p1");
      const health = queryKeys.plugins.health("p1");
      expect(detail).not.toEqual(health);
    });

    it("plugins.uiContributions returns correct static key", () => {
      expect(queryKeys.plugins.uiContributions()).toEqual(["plugins", "ui-contributions", "global"]);
    });

    it("plugins.all is a prefix of plugins.detail (cache invalidation hierarchy)", () => {
      // plugins.all = ["plugins"]
      // plugins.detail("p1") = ["plugins", "p1"]
      // React Query invalidates by prefix, so invalidating plugins.all also invalidates details
      const prefix = queryKeys.plugins.all;
      const detail = queryKeys.plugins.detail("p1");
      expect(detail.slice(0, prefix.length)).toEqual([...prefix]);
    });

    it("plugins.all is a prefix of plugins.health (cache invalidation hierarchy)", () => {
      const prefix = queryKeys.plugins.all;
      const health = queryKeys.plugins.health("p1");
      expect(health.slice(0, prefix.length)).toEqual([...prefix]);
    });

    it("plugins.uiContributions is distinct from plugins.all even though it starts with 'plugins'", () => {
      // uiContributions has an extra segment, so it WON'T be invalidated by plugins.detail("ui-contributions")
      // but WILL be invalidated by plugins.all (which is just ["plugins"])
      expect(queryKeys.plugins.uiContributions()).not.toEqual(queryKeys.plugins.all);
      expect(queryKeys.plugins.uiContributions().length).toBeGreaterThan(queryKeys.plugins.all.length);
    });

    it("plugins.config returns key including pluginId and 'config' segment", () => {
      expect(queryKeys.plugins.config("p1")).toEqual(["plugins", "p1", "config"]);
      expect(queryKeys.plugins.config("acme.test")).toEqual(["plugins", "acme.test", "config"]);
    });

    it("plugins.config and plugins.detail have distinct keys for same id", () => {
      const detail = queryKeys.plugins.detail("p1");
      const config = queryKeys.plugins.config("p1");
      expect(detail).not.toEqual(config);
    });

    it("plugins.all is a prefix of plugins.config (cache invalidation hierarchy)", () => {
      const prefix = queryKeys.plugins.all;
      const config = queryKeys.plugins.config("p1");
      expect(config.slice(0, prefix.length)).toEqual([...prefix]);
    });

    it("plugins.companyList returns key including company id and availability filter", () => {
      expect(queryKeys.plugins.companyList("c1")).toEqual(["plugins", "company", "c1", "list", "all"]);
      expect(queryKeys.plugins.companyList("c1", true)).toEqual(["plugins", "company", "c1", "list", true]);
      expect(queryKeys.plugins.companyList("c1", false)).toEqual(["plugins", "company", "c1", "list", false]);
    });

    it("plugins.company returns the shared company-scoped plugin prefix", () => {
      expect(queryKeys.plugins.company("c1")).toEqual(["plugins", "company", "c1"]);
    });

    it("plugins.companyDetail returns key including company id and plugin id", () => {
      expect(queryKeys.plugins.companyDetail("c1", "p1")).toEqual(["plugins", "company", "c1", "p1"]);
    });

    it("plugins.all is a prefix of plugins.companyList", () => {
      const prefix = queryKeys.plugins.all;
      const companyList = queryKeys.plugins.companyList("c1");
      expect(companyList.slice(0, prefix.length)).toEqual([...prefix]);
    });

    it("plugins.all is a prefix of plugins.companyDetail", () => {
      const prefix = queryKeys.plugins.all;
      const companyDetail = queryKeys.plugins.companyDetail("c1", "p1");
      expect(companyDetail.slice(0, prefix.length)).toEqual([...prefix]);
    });

    it("plugins.company is a prefix of company-scoped plugin list and detail keys", () => {
      const prefix = queryKeys.plugins.company("c1");
      expect(queryKeys.plugins.companyList("c1").slice(0, prefix.length)).toEqual([...prefix]);
      expect(queryKeys.plugins.companyDetail("c1", "p1").slice(0, prefix.length)).toEqual([...prefix]);
    });
  });

  // ---------------------------------------------------------------------------
  // Existing keys — sanity checks to prevent regressions
  // ---------------------------------------------------------------------------
  describe("existing keys not broken by plugins addition", () => {
    it("companies.all unchanged", () => {
      expect(queryKeys.companies.all).toEqual(["companies"]);
    });

    it("agents.list returns correct key", () => {
      expect(queryKeys.agents.list("c1")).toEqual(["agents", "c1"]);
    });

    it("health key unchanged", () => {
      expect(queryKeys.health).toEqual(["health"]);
    });
  });
});
