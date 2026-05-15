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

const CHECKWX_BASE = "https://api.checkwx.com";
const CHECKWX_API_KEY = Deno.env.get("CHECKWX_API_KEY") ?? "";

export async function handleNotamQuery(station: string): Promise<QueryResult> {
  try {
    if (!CHECKWX_API_KEY) {
      const msg = "NOTAM queries require a <code>CHECKWX_API_KEY</code> environment variable. Ask Christie to set one up (free tier available at checkwx.com).";
      console.warn("NOTAM query blocked: CHECKWX_API_KEY not configured");
      return { text: msg };
    }
    const url = `${CHECKWX_BASE}/notam/${encodeURIComponent(station.toUpperCase())}`;
    const res = await fetch(url, {
      headers: { "X-API-Key": CHECKWX_API_KEY },
    });
    if (!res.ok) {
      throw new Error(`CheckWX API returned ${res.status}`);
    }
    const body = await res.json();
    const notams: Array<{ notam_id: string; body: string }> = body.data ?? [];
    if (notams.length === 0) {
      return {
        text: `No NOTAMs found for <code>${escapeHtml(station.toUpperCase())}</code>.`,
      };
    }
    const maxNotams = 5;
    const entries = notams.slice(0, maxNotams).map((n) => `<code>${escapeHtml(n.body)}</code>`).join("\n\n");
    const total = notams.length;
    const summary = total > maxNotams
      ? `\n\n<i>…and ${total - maxNotams} more (${total} total)</i>`
      : "";
    return {
      text: [
        `<b>NOTAMs for ${escapeHtml(station.toUpperCase())}</b>`,
        "",
        entries,
        summary,
        WEATHER_DISCLAIMER,
      ].join("\n"),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`NOTAM query for ${station} failed: ${message}`);
    return {
      text: `Unable to fetch NOTAMs for <code>${escapeHtml(station)}</code>: ${escapeHtml(message)}`,
    };
  }
}

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
    console.error(`METAR query for ${station} failed: ${message}`);
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
    console.error(`TAF query for ${station} failed: ${message}`);
    return {
      text: `Unable to fetch TAF for <code>${escapeHtml(station)}</code>: ${escapeHtml(message)}`,
    };
  }
}
