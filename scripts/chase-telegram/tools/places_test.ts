import { assertEquals, assertStringIncludes } from "std/testing/asserts.ts";
import {
  setupMockFetch,
  teardownMockFetch,
  mockJsonResponse,
  mockTextResponse,
  mockFetch,
} from "../test_helpers.ts";

Deno.test({
  name: "handleMoviesNearby returns formatted cinema list",
  async fn() {
    setupMockFetch();
    const { handleMoviesNearby } = await import("./places.ts");

    mockFetch(/nominatim/, () =>
      mockJsonResponse([{ lat: "30.2672", lon: "-97.7431", display_name: "Austin, Texas, USA" }])
    );

    mockFetch(/overpass-api/, () =>
      mockJsonResponse({
        elements: [
          {
            tags: { name: "Alamo Drafthouse", "addr:street": "South Lamar Blvd", "addr:housenumber": "1120" },
          },
        ],
      })
    );

    const result = await handleMoviesNearby("Austin");
    assertStringIncludes(result.text, "Cinemas near Austin");
    assertStringIncludes(result.text, "Alamo Drafthouse");
    assertStringIncludes(result.text, "OpenStreetMap");
    teardownMockFetch();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "handleRestaurantsNearby returns formatted restaurant list",
  async fn() {
    setupMockFetch();
    const { handleRestaurantsNearby } = await import("./places.ts");

    mockFetch(/nominatim/, () =>
      mockJsonResponse([{ lat: "40.7128", lon: "-74.0060", display_name: "New York, USA" }])
    );

    mockFetch(/overpass-api/, () =>
      mockJsonResponse({
        elements: [
          {
            tags: { name: "Katz's Deli", "addr:street": "Houston St", "addr:housenumber": "205" },
          },
        ],
      })
    );

    const result = await handleRestaurantsNearby("New York");
    assertStringIncludes(result.text, "Restaurants near New York");
    assertStringIncludes(result.text, "Katz's Deli");
    teardownMockFetch();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "handleHotelsNearby returns formatted hotel list",
  async fn() {
    setupMockFetch();
    const { handleHotelsNearby } = await import("./places.ts");

    mockFetch(/nominatim/, () =>
      mockJsonResponse([{ lat: "51.5074", lon: "-0.1278", display_name: "London, UK" }])
    );

    mockFetch(/overpass-api/, () =>
      mockJsonResponse({
        elements: [
          {
            tags: { name: "The Ritz", "addr:street": "Piccadilly", "addr:housenumber": "150" },
          },
        ],
      })
    );

    const result = await handleHotelsNearby("London");
    assertStringIncludes(result.text, "Hotels near London");
    assertStringIncludes(result.text, "The Ritz");
    teardownMockFetch();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "handleMoviesNearby returns no-cinemas message when empty",
  async fn() {
    setupMockFetch();
    const { handleMoviesNearby } = await import("./places.ts");

    mockFetch(/nominatim/, () =>
      mockJsonResponse([{ lat: "35.0", lon: "-115.0", display_name: "Death Valley, USA" }])
    );

    mockFetch(/overpass-api/, () => mockJsonResponse({ elements: [] }));

    const result = await handleMoviesNearby("Death Valley");
    assertStringIncludes(result.text, "No cinemas");
    teardownMockFetch();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "handleRestaurantsNearby returns error on geocode failure",
  async fn() {
    setupMockFetch();
    const { handleRestaurantsNearby } = await import("./places.ts");

    mockFetch(/nominatim/, () => mockJsonResponse([], 200));
    mockFetch(/overpass-api/, () => mockJsonResponse({ elements: [] }));

    const result = await handleRestaurantsNearby("Nowhereland");
    assertStringIncludes(result.text, "Could not find restaurants");
    teardownMockFetch();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "handleMoviesNearby filters out unnamed places",
  async fn() {
    setupMockFetch();
    const { handleMoviesNearby } = await import("./places.ts");

    mockFetch(/nominatim/, () =>
      mockJsonResponse([{ lat: "48.8566", lon: "2.3522", display_name: "Paris, France" }])
    );

    mockFetch(/overpass-api/, () =>
      mockJsonResponse({
        elements: [
          { tags: { name: "Le Grand Rex", "addr:street": "Boulevard Poissonnière" } },
          { tags: { "addr:street": "Rue de la Paix" } },
          { tags: { name: "Cinémathèque Française" } },
        ],
      })
    );

    const result = await handleMoviesNearby("Paris");
    assertStringIncludes(result.text, "Le Grand Rex");
    assertStringIncludes(result.text, "Cinémathèque Française");
    assertEquals(result.text.includes("Rue de la Paix"), false);
    teardownMockFetch();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "PLACES_DISCLAIMER constant is exported",
  async fn() {
    const { PLACES_DISCLAIMER } = await import("./places.ts");
    assertStringIncludes(PLACES_DISCLAIMER, "OpenStreetMap");
  },
  sanitizeResources: false,
  sanitizeOps: false,
});
