import { assertEquals, assertStringIncludes } from "std/testing/asserts.ts";
import {
  setupMockFetch,
  teardownMockFetch,
  mockJsonResponse,
  mockFetch,
} from "../test_helpers.ts";

function cleanEnv(): void {
  Deno.env.delete("TAVILY_API_KEY");
  Deno.env.delete("SERPAPI_API_KEY");
}

Deno.test({
  name: "handleWebSearch returns formatted Tavily results when configured",
  async fn() {
    cleanEnv();
    Deno.env.set("TAVILY_API_KEY", "test-key");
    setupMockFetch();
    const { handleWebSearch } = await import("./web_search.ts");

    mockFetch(/tavily/, () =>
      mockJsonResponse({
        results: [
      { title: "AI News Today", url: "https://example.com/ai", content: "Latest developments in artificial intelligence." },
      { title: "Machine Learning Guide", url: "https://example.com/ml", content: "A comprehensive guide to ML." },
        ],
      })
    );

    const result = await handleWebSearch("AI news");
    assertStringIncludes(result.text, "Search results for");
    assertStringIncludes(result.text, "AI News Today");
    assertStringIncludes(result.text, "Machine Learning Guide");
    assertStringIncludes(result.text, "Tavily");
    Deno.env.delete("TAVILY_API_KEY");
    teardownMockFetch();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "handleWebSearch returns formatted SerpAPI results when configured",
  async fn() {
    cleanEnv();
    Deno.env.set("SERPAPI_API_KEY", "test-key");
    setupMockFetch();
    const { handleWebSearch } = await import("./web_search.ts");

    mockFetch(/serpapi/, () =>
      mockJsonResponse({
        organic_results: [
          { title: "Result 1", link: "https://example.com/1", snippet: "First result snippet." },
        ],
      })
    );

    const result = await handleWebSearch("test query");
    assertStringIncludes(result.text, "Search results for");
    assertStringIncludes(result.text, "Result 1");
    assertStringIncludes(result.text, "SerpAPI");
    Deno.env.delete("SERPAPI_API_KEY");
    teardownMockFetch();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "handleWebSearch returns DuckDuckGo results as fallback",
  async fn() {
    cleanEnv();
    setupMockFetch();
    const { handleWebSearch } = await import("./web_search.ts");

    mockFetch(/duckduckgo/, () =>
      mockJsonResponse({
        AbstractText: "DuckDuckGo is a search engine.",
        AbstractSource: "DuckDuckGo",
        AbstractURL: "https://duckduckgo.com",
        RelatedTopics: [
          { Text: "Privacy-focused search engine.", FirstURL: "https://duckduckgo.com/privacy" },
        ],
      })
    );

    const result = await handleWebSearch("DuckDuckGo");
    assertStringIncludes(result.text, "Search results for");
    assertStringIncludes(result.text, "DuckDuckGo is a search engine");
    teardownMockFetch();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "handleWebSearch returns no-results message",
  async fn() {
    cleanEnv();
    Deno.env.set("TAVILY_API_KEY", "test-key");
    setupMockFetch();
    const { handleWebSearch } = await import("./web_search.ts");

    mockFetch(/tavily/, () => mockJsonResponse({ results: [] }));

    const result = await handleWebSearch("xyznonexistent12345");
    assertStringIncludes(result.text, "No search results");
    Deno.env.delete("TAVILY_API_KEY");
    teardownMockFetch();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "handleWebSearch returns error on API failure",
  async fn() {
    cleanEnv();
    Deno.env.set("TAVILY_API_KEY", "test-key");
    setupMockFetch();
    const { handleWebSearch } = await import("./web_search.ts");

    mockFetch(/tavily/, () => new Response("Server Error", { status: 500 }));

    const result = await handleWebSearch("test");
    assertStringIncludes(result.text, "Web search is currently unavailable");
    Deno.env.delete("TAVILY_API_KEY");
    teardownMockFetch();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "isWebSearchConfigured returns true when Tavily key set",
  async fn() {
    cleanEnv();
    Deno.env.set("TAVILY_API_KEY", "key");
    const { isWebSearchConfigured } = await import("./web_search.ts");
    assertEquals(isWebSearchConfigured(), true);
    Deno.env.delete("TAVILY_API_KEY");
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "isWebSearchConfigured returns true when SerpAPI key set",
  async fn() {
    cleanEnv();
    Deno.env.set("SERPAPI_API_KEY", "key");
    const { isWebSearchConfigured } = await import("./web_search.ts");
    assertEquals(isWebSearchConfigured(), true);
    Deno.env.delete("SERPAPI_API_KEY");
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "isWebSearchConfigured returns false without keys",
  async fn() {
    cleanEnv();
    const { isWebSearchConfigured } = await import("./web_search.ts");
    assertEquals(isWebSearchConfigured(), false);
  },
  sanitizeResources: false,
  sanitizeOps: false,
});
