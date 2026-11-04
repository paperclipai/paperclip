export default (ctx) => `import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { registry } from "./registry";

const CURVE = "300ms cubic-bezier(0.3, 0, 0.1, 1)";

function labRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  if (existsSync(path.join(here, "directions"))) return here;
  let dir = process.cwd();
  for (;;) {
    const candidate = path.join(dir, "ui/src/${ctx.slug}-directions");
    if (existsSync(path.join(candidate, "directions"))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error("cannot locate ui/src/${ctx.slug}-directions from " + process.cwd());
    dir = parent;
  }
}

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return sources(file);
    return entry.name.endsWith(".tsx") ? [file] : [];
  });
}

function mediaBlock(css: string): { inner: string; rest: string } {
  const open = css.indexOf("@media (prefers-reduced-motion: no-preference) {");
  expect(open, "a prefers-reduced-motion: no-preference block").toBeGreaterThan(-1);
  let depth = 0;
  for (let i = css.indexOf("{", open); i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        const start = css.indexOf("{", open) + 1;
        return { inner: css.slice(start, i), rest: css.slice(0, open) + css.slice(i + 1) };
      }
    }
  }
  throw new Error("unbalanced @media block");
}

const rules = (css: string) => [...css.matchAll(/([^{}]+)\\{([^{}]*)\\}/g)].map((match) => ({ selector: match[1].trim(), body: match[2].trim() }));

const explorations = registry.directions.filter((direction) => !direction.baseline);
const root = labRoot();

describe("the V1 MVP motion contract", () => {
  it("gives Today no tokens.css and every exploration one", () => {
    expect(existsSync(path.join(root, "directions/today/tokens.css"))).toBe(false);
    for (const direction of explorations) expect(existsSync(path.join(root, "directions", direction.id, "tokens.css")), direction.id).toBe(true);
  });

  for (const direction of explorations) {
    const id = direction.id;
    const prefix = id.replace(/^d\\d+-/, "");
    const scope = \`[data-direction="\${id}"]\`;
    const gate = \`html[data-lab-anim="1"] \${scope}\`;

    describe(id, () => {
      const css = readFileSync(path.join(root, "directions", id, "tokens.css"), "utf8").replace(/\\/\\*[\\s\\S]*?\\*\\//g, "");
      const { inner, rest } = mediaBlock(css);

      it("declares the one curve once, under its own scope, and no other timing", () => {
        const eases = [...css.matchAll(/--([a-z0-9-]+)-hover-ease:\\s*([^;]+);/g)];
        expect(eases).toHaveLength(1);
        expect(eases[0][1]).toBe(prefix);
        expect(eases[0][2].trim()).toBe(CURVE);
        expect(rules(rest).some((rule) => rule.selector === scope && rule.body.includes(\`--\${prefix}-hover-ease: \${CURVE}\`))).toBe(true);
        expect(css.match(/cubic-bezier\\(/g)).toHaveLength(1);
        expect(css.match(/\\d+ms/g)).toHaveLength(1);
      });

      it("transitions transform alone, on the backings and the front, with the curve", () => {
        const transitions = [...css.matchAll(/transition:\\s*([^;]+);/g)];
        expect(transitions).toHaveLength(1);
        expect(transitions[0][1].trim()).toBe(\`transform var(--\${prefix}-hover-ease)\`);
        expect(css).not.toMatch(/transition:\\s*(filter|box-shadow|opacity|scale)/);
        const transitionRule = rules(inner).find((rule) => rule.body.startsWith("transition:"));
        expect(transitionRule?.selector).toBe(\`\${gate} :is([data-rotate][data-spread], [data-front])\`);
      });

      it("gates every movement on the lab toggle and reduced motion", () => {
        const gated = rules(inner);
        expect(gated).toHaveLength(4);
        for (const rule of gated) expect(rule.selector.startsWith(gate)).toBe(true);
        expect(rest).not.toContain("data-lab-anim");
      });

      it("rises the front 6px and fans the backings 5 degrees on hover", () => {
        const hover = rules(inner).filter((rule) => !rule.body.startsWith("transition:"));
        const triggers = [\`\${gate} button:hover \`, \`\${gate} .\${prefix}-tile:hover \`];
        const byTarget = Object.fromEntries(hover.map((rule) => [rule.selector.slice(rule.selector.lastIndexOf(" ") + 1), rule]));
        expect(Object.keys(byTarget).sort()).toEqual(['[data-front]', '[data-spread="left"]', '[data-spread="right"]']);
        for (const rule of hover) expect(triggers.some((trigger) => rule.selector.startsWith(trigger)), rule.selector).toBe(true);
        expect(byTarget["[data-front]"].body).toBe("transform: translateY(-6px);");
        expect(byTarget['[data-spread="left"]'].body).toBe(\`transform: rotate(calc(var(--\${prefix}-base, 0deg) + 5deg));\`);
        expect(byTarget['[data-spread="right"]'].body).toBe(\`transform: rotate(calc(var(--\${prefix}-base, 0deg) - 5deg));\`);
      });

      it("rests the backings on their inline angle outside both gates", () => {
        const rest_ = rules(rest).find((rule) => rule.selector === \`\${scope} [data-rotate]\`);
        expect(rest_?.body).toBe(\`transform: rotate(var(--\${prefix}-base, 0deg));\`);
      });

      it("carries the three hooks in its components", () => {
        const code = sources(path.join(root, "directions", id)).map((file) => readFileSync(file, "utf8")).join("\\n");
        for (const hook of ["data-front", "data-rotate", "data-spread"]) expect(code, hook).toContain(hook);
        expect(code).toContain(\`--\${prefix}-base\`);
      });
    });
  }
});
`;
