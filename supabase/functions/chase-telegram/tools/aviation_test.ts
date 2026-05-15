import { assertEquals, assertStringIncludes } from "std/testing/asserts.ts";
import { WEATHER_DISCLAIMER, handleMetarQuery, handleTafQuery } from "./aviation.ts";
import { setupMockFetch, teardownMockFetch, mockTextResponse, mockFetch } from "../test_helpers.ts";

Deno.test("WEATHER_DISCLAIMER includes 'not for flight planning'", () => {
  assertStringIncludes(WEATHER_DISCLAIMER, "Not for flight planning");
});

Deno.test("WEATHER_DISCLAIMER includes NOAA source attribution", () => {
  assertStringIncludes(WEATHER_DISCLAIMER, "NOAA Aviation Weather Center");
});

Deno.test("WEATHER_DISCLAIMER includes aviationweather.gov URL", () => {
  assertStringIncludes(WEATHER_DISCLAIMER, "aviationweather.gov");
});

Deno.test("WEATHER_DISCLAIMER includes safety note", () => {
  assertStringIncludes(WEATHER_DISCLAIMER, "official briefings");
});

Deno.test("WEATHER_DISCLAIMER is not empty", () => {
  assertEquals(WEATHER_DISCLAIMER.length > 0, true);
});

Deno.test({
  name: "handleMetarQuery returns formatted METAR data",
  async fn() {
    setupMockFetch();
    mockFetch(/aviationweather\.gov\/api\/data\/metar/, () =>
      mockTextResponse("KJFK 151651Z 21015G25KT 10SM FEW025 BKN045 22/14 A3002")
    );
    const result = await handleMetarQuery("KJFK");
    assertStringIncludes(result.text, "METAR for KJFK");
    assertStringIncludes(result.text, "KJFK 151651Z");
    assertStringIncludes(result.text, "Not for flight planning");
    teardownMockFetch();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "handleMetarQuery handles API error gracefully",
  async fn() {
    setupMockFetch();
    mockFetch(/aviationweather\.gov/, () => new Response("Service Unavailable", { status: 503 }));
    const result = await handleMetarQuery("KJFK");
    assertStringIncludes(result.text, "Unable to fetch METAR");
    teardownMockFetch();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "handleMetarQuery handles empty response",
  async fn() {
    setupMockFetch();
    mockFetch(/aviationweather\.gov\/api\/data\/metar/, () => mockTextResponse("  "));
    const result = await handleMetarQuery("KJFK");
    assertStringIncludes(result.text, "Unable to fetch METAR");
    teardownMockFetch();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "handleTafQuery returns formatted TAF data",
  async fn() {
    setupMockFetch();
    mockFetch(/aviationweather\.gov\/api\/data\/taf/, () =>
      mockTextResponse("KJFK 151120Z 1512/1618 20012G20KT P6SM SCT035 BKN050")
    );
    const result = await handleTafQuery("KJFK");
    assertStringIncludes(result.text, "TAF for KJFK");
    assertStringIncludes(result.text, "KJFK 151120Z");
    assertStringIncludes(result.text, "Not for flight planning");
    teardownMockFetch();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "handleTafQuery handles API error gracefully",
  async fn() {
    setupMockFetch();
    mockFetch(/aviationweather\.gov\/api\/data\/taf/, () =>
      new Response("Not Found", { status: 404 })
    );
    const result = await handleTafQuery("KXXX");
    assertStringIncludes(result.text, "Unable to fetch TAF");
    teardownMockFetch();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});
