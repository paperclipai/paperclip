import { assertEquals, assertStringIncludes } from "std/testing/asserts.ts";
import { WEATHER_DISCLAIMER } from "./aviation.ts";

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
