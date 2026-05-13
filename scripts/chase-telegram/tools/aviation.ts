import { escapeHtml } from "../lib/html.ts";
import type { QueryResult } from "../types.ts";

const AVIATION_WEATHER_BASE = "https://aviationweather.gov/api/data";

async function fetchAviationWeather(
  endpoint: string,
  station: string,
): Promise<string> {
  const url =
    `${AVIATION_WEATHER_BASE}/${endpoint}?ids=${encodeURIComponent(station)}&format=raw`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Aviation weather API returned ${res.status}`);
  }
  const text = await res.text();
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error(
      `No weather data found for station "${escapeHtml(station)}". Check the airport code and try again.`,
    );
  }
  return trimmed;
}

export const WEATHER_DISCLAIMER = "\n\n<i>Not for flight planning. Source: NOAA Aviation Weather Center (aviationweather.gov). Data may be delayed — always consult official briefings for flight decisions.</i>";

export async function handleMetarQuery(station: string): Promise<QueryResult> {
  try {
    const raw = await fetchAviationWeather("metar", station);
    return {
      text: [
        `<b>METAR for ${escapeHtml(station.toUpperCase())}</b>`,
        "",
        `<code>${escapeHtml(raw)}</code>`,
        WEATHER_DISCLAIMER,
      ].join("\n"),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      text: `Unable to fetch METAR for <code>${escapeHtml(station)}</code>: ${escapeHtml(message)}`,
    };
  }
}

export async function handleTafQuery(station: string): Promise<QueryResult> {
  try {
    const raw = await fetchAviationWeather("taf", station);
    return {
      text: [
        `<b>TAF for ${escapeHtml(station.toUpperCase())}</b>`,
        "",
        `<code>${escapeHtml(raw)}</code>`,
        WEATHER_DISCLAIMER,
      ].join("\n"),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      text: `Unable to fetch TAF for <code>${escapeHtml(station)}</code>: ${escapeHtml(message)}`,
    };
  }
}
