import { escapeHtml } from "../lib/html.ts";
import type { QueryResult } from "../types.ts";

const NOMINATIM_BASE = "https://nominatim.openstreetmap.org";
const OVERPASS_BASE = "https://overpass-api.de/api/interpreter";

interface Coordinates {
  lat: number;
  lon: number;
  displayName: string;
}

interface Place {
  name: string;
  address: string;
}

async function geocodeLocation(location: string): Promise<Coordinates> {
  const url = `${NOMINATIM_BASE}/search?q=${encodeURIComponent(location)}&format=json&limit=1`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Chase-Paperclip-Bot/1.0" },
  });
  if (!res.ok) throw new Error(`Geocoding failed: ${res.status}`);
  const data = await res.json();
  if (!data || data.length === 0) {
    throw new Error(`Location "${location}" not found. Try a city name or address.`);
  }
  return {
    lat: parseFloat(data[0].lat),
    lon: parseFloat(data[0].lon),
    displayName: data[0].display_name,
  };
}

async function searchNearby(
  lat: number,
  lon: number,
  overpassQuery: string,
  resultLabel: string,
): Promise<Place[]> {
  const url = `${OVERPASS_BASE}/interpreter`;
  const body = `data=${encodeURIComponent(overpassQuery)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`Places search returned ${res.status}`);
  const data = await res.json();
  const elements = data.elements || [];
  if (elements.length === 0) return [];
  return elements
    .filter((el: Record<string, unknown>) => el.tags && typeof el.tags === "object")
    .map((el: Record<string, unknown>) => {
      const tags = el.tags as Record<string, string>;
      const street = tags["addr:street"] || "";
      const housenumber = tags["addr:housenumber"] || "";
      const addrParts = [street, housenumber].filter(Boolean);
      const city = tags["addr:city"] || tags["addr:suburb"] || "";
      if (city && addrParts.length > 0) addrParts.push(city);
      return {
        name: tags.name || tags.brand || "Unknown",
        address: addrParts.length > 0 ? addrParts.join(" ") : "",
      };
    })
    .filter((p: Place) => p.name !== "Unknown");
}

export async function handleMoviesNearby(location: string): Promise<QueryResult> {
  try {
    const coords = await geocodeLocation(location);
    const query =
      `[out:json];(node["amenity"="cinema"](around:2000,${coords.lat},${coords.lon});node["amenity"="theatre"](around:2000,${coords.lat},${coords.lon}););out 10;`;
    const places = await searchNearby(coords.lat, coords.lon, query, "cinemas");
    const areaName = coords.displayName.split(",")[0];
    if (places.length === 0) {
      return {
        text: `No cinemas or theatres found within 2km of <b>${escapeHtml(areaName)}</b>.`,
      };
    }
    const lines = [
      `<b>Cinemas near ${escapeHtml(areaName)}</b>`,
      "",
      ...places.map(
        (p, i) =>
          `${i + 1}. <b>${escapeHtml(p.name)}</b>${p.address ? ` — ${escapeHtml(p.address)}` : ""}`,
      ),
      PLACES_DISCLAIMER,
    ];
    return { text: lines.join("\n") };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { text: `Could not find cinemas: ${escapeHtml(message)}` };
  }
}

export async function handleRestaurantsNearby(location: string): Promise<QueryResult> {
  try {
    const coords = await geocodeLocation(location);
    const query =
      `[out:json];(node["amenity"="restaurant"](around:1000,${coords.lat},${coords.lon}););out 10;`;
    const places = await searchNearby(coords.lat, coords.lon, query, "restaurants");
    const areaName = coords.displayName.split(",")[0];
    if (places.length === 0) {
      return {
        text: `No restaurants found within 1km of <b>${escapeHtml(areaName)}</b>.`,
      };
    }
    const lines = [
      `<b>Restaurants near ${escapeHtml(areaName)}</b>`,
      "",
      ...places.map(
        (p, i) =>
          `${i + 1}. <b>${escapeHtml(p.name)}</b>${p.address ? ` — ${escapeHtml(p.address)}` : ""}`,
      ),
      PLACES_DISCLAIMER,
    ];
    return { text: lines.join("\n") };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { text: `Could not find restaurants: ${escapeHtml(message)}` };
  }
}

export async function handleHotelsNearby(location: string): Promise<QueryResult> {
  try {
    const coords = await geocodeLocation(location);
    const query =
      `[out:json];(node["tourism"="hotel"](around:2000,${coords.lat},${coords.lon}););out 10;`;
    const places = await searchNearby(coords.lat, coords.lon, query, "hotels");
    const areaName = coords.displayName.split(",")[0];
    if (places.length === 0) {
      return {
        text: `No hotels found within 2km of <b>${escapeHtml(areaName)}</b>.`,
      };
    }
    const lines = [
      `<b>Hotels near ${escapeHtml(areaName)}</b>`,
      "",
      ...places.map(
        (p, i) =>
          `${i + 1}. <b>${escapeHtml(p.name)}</b>${p.address ? ` — ${escapeHtml(p.address)}` : ""}`,
      ),
      PLACES_DISCLAIMER,
    ];
    return { text: lines.join("\n") };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { text: `Could not find hotels: ${escapeHtml(message)}` };
  }
}

export async function handlePlacesNearby(
  lat: number,
  lon: number,
  placeType: "restaurant" | "cinema" | "hotel",
): Promise<QueryResult> {
  const typeLabel = placeType === "restaurant" ? "restaurants" : placeType === "cinema" ? "cinemas and theatres" : "hotels";

  let query: string;
  if (placeType === "restaurant") {
    query = `[out:json];(node["amenity"="restaurant"](around:1000,${lat},${lon}););out 10;`;
  } else if (placeType === "cinema") {
    query =
      `[out:json];(node["amenity"="cinema"](around:2000,${lat},${lon});node["amenity"="theatre"](around:2000,${lat},${lon}););out 10;`;
  } else {
    query = `[out:json];(node["tourism"="hotel"](around:2000,${lat},${lon}););out 10;`;
  }

  try {
    const places = await searchNearby(lat, lon, query, typeLabel);
    const areaName = `${lat},${lon}`;
    if (places.length === 0) {
      return {
        text: `No ${typeLabel} found nearby.`,
      };
    }
    const lines = [
      `<b>${typeLabel.charAt(0).toUpperCase() + typeLabel.slice(1)} near your location</b>`,
      "",
      ...places.map(
        (p, i) =>
          `${i + 1}. <b>${escapeHtml(p.name)}</b>${p.address ? ` — ${escapeHtml(p.address)}` : ""}`,
      ),
      PLACES_DISCLAIMER,
    ];
    return { text: lines.join("\n") };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { text: `Could not find ${typeLabel}: ${escapeHtml(message)}` };
  }
}

export const PLACES_DISCLAIMER = "\n\n<i>Data from OpenStreetMap contributors. Results may not be complete or up to date.</i>";
