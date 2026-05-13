import { assertEquals } from "std/testing/asserts.ts";
import { escapeHtml, issueLink } from "./html.ts";

Deno.test("escapeHtml escapes & < >", () => {
  assertEquals(escapeHtml("a & b < c > d"), "a &amp; b &lt; c &gt; d");
});

Deno.test("escapeHtml passes through plain text", () => {
  assertEquals(escapeHtml("hello world"), "hello world");
});

Deno.test("escapeHtml handles empty string", () => {
  assertEquals(escapeHtml(""), "");
});

Deno.test("issueLink generates correct HTML", () => {
  const result = issueLink("CRE-123");
  assertEquals(
    result,
    '<a href="https://paperclip.avva.aero/CRE/issues/CRE-123">CRE-123</a>',
  );
});

Deno.test("issueLink uses custom text when provided", () => {
  const result = issueLink("CRE-123", "Click here");
  assertEquals(
    result,
    '<a href="https://paperclip.avva.aero/CRE/issues/CRE-123">Click here</a>',
  );
});
