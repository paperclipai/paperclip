import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PAPERCLIP_EVENTS } from "@paperclipai/shared/telemetry/generated/paperclip-telemetry";

// Each event name has exactly one sender. The server sends every
// `PAPERCLIP_EVENTS` event, so browser code must never capture one too, or
// PostHog would count it twice.

const UI_SRC = fileURLToPath(new URL("../..", import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/** `x.capture("name"` with a literal name, or `x.capture(PAPERCLIP_EVENTS...`. */
function findServerEventCaptures(source: string, serverEvents: ReadonlySet<string>): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(/\.capture\(\s*(?:(["'`])([^"'`]+)\1|(PAPERCLIP_EVENTS\b[^,)]*))/g)) {
    if (match[3]) found.push(match[3].trim());
    else if (match[2] && serverEvents.has(match[2])) found.push(match[2]);
  }
  return found;
}

describe("browser analytics event ownership", () => {
  const serverEvents = new Set<string>(Object.values(PAPERCLIP_EVENTS));

  it("detects a server-owned event name passed to capture()", () => {
    expect(findServerEventCaptures(`posthog.capture("agent.created", {})`, serverEvents)).toEqual(["agent.created"]);
    expect(findServerEventCaptures(`client.capture(PAPERCLIP_EVENTS["goal.created"])`, serverEvents))
      .toEqual(['PAPERCLIP_EVENTS["goal.created"]']);
    expect(findServerEventCaptures(`posthog.capture("ui_button_clicked")`, serverEvents)).toEqual([]);
  });

  it("never captures a PAPERCLIP_EVENTS event from UI code", () => {
    const offenders = sourceFiles(UI_SRC).flatMap((file) =>
      findServerEventCaptures(readFileSync(file, "utf8"), serverEvents)
        .map((name) => `${relative(UI_SRC, file)}: ${name}`),
    );
    expect(offenders).toEqual([]);
  });
});
