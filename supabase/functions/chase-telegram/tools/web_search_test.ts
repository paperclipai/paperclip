import { assertEquals, assertStringIncludes } from "std/testing/asserts.ts";
import {
  setupMockFetch,
  teardownMockFetch,
  mockJsonResponse,
  mockFetch,
} from "../test_helpers.ts";

Deno.test({
  name: "handleWebSearch returns formatted Tavily results when configured",
  async fn() {
    setupMockFetch();
    Deno.env.set("TAVILY_API_KEY", "test-key");
    const { handleWebSearch } = await import("./web_search.ts");
    mockFetch(/tavily/, () =>
      mockJsonResponse({
        results: [
          { title: "Result 1", url: "https://example.com/1", content: "First result" },
          { title: "Result 2", url: "https://example.com/2", content: "Second result" },
        ],
      })
    );
    const result = await handleWebSearch("test query");
    assertStringIncludes(result.text, "Search results");
    assertStringIncludes(result.text, "Result 1");
    assertStringIncludes(result.text, "Result 2");
    assertStringIncludes(result.text, "Powered by Tavily");
    Deno.env.delete("TAVILY_API_KEY");
    teardownMockFetch();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "handleWebSearch returns formatted SerpAPI results when configured",
  async fn() {
    setupMockFetch();
    Deno.env.set("SERPAPI_API_KEY", "test-serp-key");
    const { handleWebSearch } = await import("./web_search.ts");
    mockFetch(/serpapi/, () =>
      mockJsonResponse({
        organic_results: [
          { title: "Serp Result", link: "https://serp.com/1", snippet: "Serp snippet" },
        ],
      })
    );
    const result = await handleWebSearch("serp test");
    assertStringIncludes(result.text, "Search results");
    assertStringIncludes(result.text, "Serp Result");
    assertStringIncludes(result.text, "Powered by SerpAPI");
    Deno.env.delete("SERPAPI_API_KEY");
    teardownMockFetch();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "handleWebSearch returns DuckDuckGo results as fallback",
  async fn() {
    setupMockFetch();
    const { handleWebSearch } = await import("./web_search.ts");
    mockFetch(/duckduckgo/, () =>
      mockJsonResponse({
        AbstractText: "DuckDuckGo result text",
        AbstractSource: "DDG",
        AbstractURL: "https://duckduckgo.com",
      })
    );
    const result = await handleWebSearch("ddg test");
    assertStringIncludes(result.text, "Search results");
    assertStringIncludes(result.text, "DuckDuckGo result text");
    assertStringIncludes(result.text, "Powered by DuckDuckGo");
    teardownMockFetch();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "handleWebSearch returns no-results message",
  async fn() {
    setupMockFetch();
    Deno.env.set("TAVILY_API_KEY", "test-key");
    const { handleWebSearch } = await import("./web_search.ts");
    mockFetch(/tavily/, () =>
      mockJsonResponse({ results: [] })
    );
    const result = await handleWebSearch("nothing");
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
    setupMockFetch();
    Deno.env.set("TAVILY_API_KEY", "test-key");
    const { handleWebSearch } = await import("./web_search.ts");
    mockFetch(/tavily/, () => new Response("Error", { status: 500 }));
    const result = await handleWebSearch("fail");
    assertStringIncludes(result.text, "unavailable");
    assertStringIncludes(result.text, "500");
    Deno.env.delete("TAVILY_API_KEY");
    teardownMockFetch();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "isWebSearchConfigured returns true when Tavily key set",
  async fn() {
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
    const { isWebSearchConfigured } = await import("./web_search.ts");
    assertEquals(isWebSearchConfigured(), false);
  },
  sanitizeResources: false,
  sanitizeOps: false,
});
