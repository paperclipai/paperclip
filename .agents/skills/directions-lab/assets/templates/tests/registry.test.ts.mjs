export default (ctx) => `import { describe, expect, it } from "vitest";
import { DIRECTION_IDS, KIT_KEYS, KIT_META, SURFACE_IDS, loadKit } from "./kit";
import { registry } from "./registry";

const KIT_DIRECTORIES = Object.keys(import.meta.glob("./directions/*/index.tsx")).map((file) => file.split("/")[2]);

describe("the ${ctx.slug} registry", () => {
  it("has unique direction ids and unique single-digit keys", () => {
    expect(new Set(DIRECTION_IDS).size).toBe(DIRECTION_IDS.length);
    const keys = Object.values(KIT_KEYS);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) expect(key).toMatch(/^[0-9]$/);
  });

  it("keeps Today as the single baseline, keyed 0 and placed last", () => {
    const baselines = registry.directions.filter((direction) => direction.baseline);
    expect(baselines.map((direction) => direction.id)).toEqual(["today"]);
    expect(KIT_KEYS.today).toBe("0");
    expect(DIRECTION_IDS[DIRECTION_IDS.length - 1]).toBe("today");
    expect(registry.baselinePosition).toBe("last");
  });

  it("names every exploration after its digit", () => {
    for (const direction of registry.directions.filter((entry) => !entry.baseline)) {
      expect(direction.id).toMatch(new RegExp(\`^d\${direction.key}-\`));
      expect(direction.name.startsWith(\`\${direction.key}.\`)).toBe(true);
    }
  });

  it("has one kit directory per direction and no stray kit", () => {
    expect([...KIT_DIRECTORIES].sort()).toEqual([...DIRECTION_IDS].sort());
  });

  it("gives each kit the registry's id, name and tagline", async () => {
    for (const id of DIRECTION_IDS) {
      const kit = await loadKit(id);
      expect(kit.id).toBe(id);
      expect(kit.name).toBe(KIT_META[id].name);
      expect(kit.tagline).toBe(KIT_META[id].tagline);
      for (const surface of SURFACE_IDS) expect(typeof kit[\`\${surface.charAt(0).toUpperCase()}\${surface.slice(1).replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase())}Body\` as keyof typeof kit]).toBe("function");
    }
  });

  it("lands on a view the registry knows", () => {
    expect([...DIRECTION_IDS, "all"]).toContain(registry.landing.direction);
    expect([...SURFACE_IDS, "board"]).toContain(registry.landing.view);
  });

  it("records its story id and provenance", () => {
    expect(registry.storyId).toBe(${JSON.stringify(ctx.storyId)});
    expect(registry.provenance.createdAt).toMatch(/^\\d{4}-\\d{2}-\\d{2}$/);
    for (const direction of registry.directions) expect(["shipped", "proposed", "adopted", "current", "historical"]).toContain(direction.stage);
  });
});
`;
