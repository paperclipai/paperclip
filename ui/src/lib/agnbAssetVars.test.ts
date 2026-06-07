import { describe, expect, it } from "vitest";
import { render, extractVars } from "./agnbAssetVars";

describe("render — XSS hardening", () => {
  it("HTML-escapes a fill value so it can't break out of text context", () => {
    const out = render("<p>Hi {{name}}</p>", { name: `"><script>steal()</script>` });
    expect(out).not.toMatch(/<script>steal/);
    expect(out).toContain("&lt;script&gt;steal()&lt;/script&gt;");
  });

  it("escapes quotes so a value can't break out of an attribute", () => {
    const out = render(`<img src="{{logo_url}}">`, {
      logo_url: `x" onerror="alert(document.cookie)`,
    });
    expect(out).not.toMatch(/onerror="alert/);
    expect(out).toContain("&quot;");
  });

  it("strips <script> blocks from the template entirely", () => {
    const out = render(`<div>{{name}}</div><script>alert(1)</script>`, { name: "Ada" });
    expect(out).not.toMatch(/<script>/i);
    expect(out).toContain("<div>Ada</div>");
  });

  it("escapes single-brace values too", () => {
    const out = render("<p>{name}</p>", { name: "<b>x</b>" });
    expect(out).toContain("&lt;b&gt;x&lt;/b&gt;");
  });

  it("does not over-escape legitimate text (ampersand round-trips for display)", () => {
    expect(render("{{c}}", { c: "Tom & Co" })).toBe("Tom &amp; Co");
  });

  it("leaves authored template markup untouched", () => {
    const out = render(`<a href="https://x.test">link</a> {{name}}`, { name: "Ada" });
    expect(out).toContain(`<a href="https://x.test">link</a>`);
  });

  it("preserves <style> blocks verbatim (CSS not corrupted by substitution)", () => {
    const out = render(`<style>.body{color:red}</style><p>{{name}}</p>`, { name: "Ada" });
    expect(out).toContain("<style>.body{color:red}</style>");
    expect(out).toContain("<p>Ada</p>");
  });

  it("does not extract or fill vars inside <style>/<script> (parity with render)", () => {
    const tmpl = `<style>.x{color:{brand}}</style><p>{{name}}</p><script>var {evil}=1</script>`;
    expect(extractVars(tmpl).map((v) => v.name)).toEqual(["name"]);
    // {brand} inside <style> stays literal; <script> is dropped.
    const out = render(tmpl, { name: "Ada", brand: "blue", evil: "x" });
    expect(out).toContain("{brand}");
    expect(out).not.toMatch(/<script>/i);
  });

  it("renders missing values as empty string for {{ }} form", () => {
    expect(render("<p>{{missing}}</p>", {})).toBe("<p></p>");
  });
});
