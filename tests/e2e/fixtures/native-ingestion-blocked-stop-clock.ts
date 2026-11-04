// Gate and two-frame observer copied from frozen H5c e431ec63, narrowed to one owned participant.
import { createServer, type ServerResponse } from "node:http";
import { expect, type Page } from "@playwright/test";
export type SeenMarker = { markerCode: string; index: number; visibleMs: number };
export type Emission = { nonce: string; markerCode: string; index: number; intendedMs: number; emittedMs: number; receivedAtMs: number };
type ClockStream = { nonce: string; markerCode: string; opened: boolean; hello: boolean; ended: boolean; aborted: boolean;
  partialBytes: number; records: Map<number, Emission>; error?: string; expectedLauncher: "host-local" | "staged-remote";
  launcher?: string; providerPid?: number; providerReadyAtMs?: number; clockHelloAtMs?: number; readinessObservedAtMs?: number };
type ClockCase = { events: number; intervalMs: number; epochMs?: number; streams: Map<string, ClockStream>; errors: string[] };
export async function openClock(page: Page) {
  const pending = new Map<string, Map<string, ServerResponse>>();
  const clocks = new Map<string, ClockCase>();
  let markerCounter = 0;
  const nextMarkerCode = () => {
    expect(markerCounter).toBeLessThan(36 ** 2);
    return (markerCounter++).toString(36).padStart(2, "0");
  };
  const gate = createServer((req, res) => {
    const url = new URL(req.url!, "http://127.0.0.1");
    const route = url.pathname.match(/^\/native-ingestion-gate\/([a-f0-9]{32})(\/clock)?$/);
    const key = route?.[1], participant = url.searchParams.get("participant");
    const state = key ? clocks.get(key) : undefined;
    const stream = participant ? state?.streams.get(participant) : undefined;
    if (!key || !participant || !state || !stream) { res.writeHead(404).end(); return; }
    if (!route?.[2] && req.method === "GET") {
      if (pending.get(key)!.has(participant)) { res.writeHead(409).end(); return; }
      stream.providerReadyAtMs = Date.now();
      pending.get(key)!.set(participant, res);
      res.on("close", () => pending.get(key)?.delete(participant));
      return;
    }
    if (!route?.[2] || req.method !== "POST" || stream.opened) { res.writeHead(409).end(); return; }
    stream.opened = true;
    let buffered = "";
    req.setEncoding("utf8");
    const fail = (message: string) => {
      stream.error = message; state.errors.push(`${participant}: ${message}`);
      if (!res.writableEnded) res.writeHead(400).end();
    };
    const line = (text: string) => {
      const value = JSON.parse(text);
      if (value.nonce !== participant || value.markerCode !== stream.markerCode) throw new Error("Clock identity mismatch");
      if (!stream.hello) {
        if (value.type !== "hello" || value.events !== state.events || value.intervalMs !== state.intervalMs
          || value.launcher !== stream.expectedLauncher || !Number.isSafeInteger(value.providerPid) || value.providerPid <= 1
          || Object.keys(value).sort().join(",") !== "events,intervalMs,launcher,markerCode,nonce,providerPid,type") throw new Error("Clock hello mismatch");
        stream.launcher = value.launcher; stream.providerPid = value.providerPid;
        stream.hello = true; stream.clockHelloAtMs = Date.now(); return;
      }
      if (value.type !== "emission" || !Number.isSafeInteger(value.index) || value.index < 0 || value.index >= state.events
        || !Number.isSafeInteger(value.intendedMs) || !Number.isSafeInteger(value.emittedMs) || value.emittedMs <= 0
        || value.intendedMs !== state.epochMs! + value.index * state.intervalMs) throw new Error("Invalid original emission clock");
      if (stream.records.has(value.index)) throw new Error("Duplicate or conflicting original emission clock");
      stream.records.set(value.index, { nonce: participant, markerCode: stream.markerCode, index: value.index,
        intendedMs: value.intendedMs, emittedMs: value.emittedMs, receivedAtMs: Date.now() });
    };
    req.on("data", (chunk: string) => {
      if (stream.error) return;
      try {
        buffered += chunk;
        for (;;) {
          const end = buffered.indexOf("\n"); if (end < 0) break;
          const text = buffered.slice(0, end); buffered = buffered.slice(end + 1);
          if (text.length > 1024) throw new Error("Clock record exceeds bounded metadata size");
          if (text) line(text);
        }
        if (buffered.length > 1024) throw new Error("Clock record exceeds bounded metadata size");
      } catch (error) { fail(String(error)); }
    });
    req.on("end", () => {
      stream.ended = true; stream.partialBytes = Buffer.byteLength(buffered);
      if (buffered.length) fail("Clock stream ended with a partial record");
      if (!stream.error && !res.writableEnded) res.writeHead(200).end();
    });
    req.on("aborted", () => { stream.aborted = true; stream.partialBytes = Buffer.byteLength(buffered); });
    req.on("error", error => { if (!stream.aborted) fail(String(error)); });
  });
  await new Promise<void>(resolve => gate.listen(0, "127.0.0.1", resolve));
  const address = gate.address();
  if (!address || typeof address === "string") throw new Error("Local ingestion gate failed");
  const base = `http://127.0.0.1:${address.port}/native-ingestion-gate/`;
  await page.addInitScript(() => {
    const seen = new Set<string>(), visible: SeenMarker[] = [];
    Object.assign(window, { nativeIngestionVisible: visible });
    let scheduled = false, dirty = false;
    const snapshot = () => {
      const text = document.body?.innerText ?? "";
      const pattern = /\[([a-z0-9]{2})([a-z0-9]{1,3})\]/g;
      const entries: Omit<SeenMarker, "visibleMs">[] = [];
      for (const match of text.matchAll(pattern)) {
        const index = Number.parseInt(match[2], 36);
        const key = `${match[1]}:${index}`;
        if (seen.has(key)) continue;
        entries.push({ markerCode: match[1], index });
      }
      return entries;
    };
    const schedule = () => {
      dirty = true;
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        dirty = false;
        const entries = snapshot();
        requestAnimationFrame(() => {
          // Only stamp the previous frame's snapshot. A token inserted
          // between frames has not had this snapshot's paint opportunity.
          const visibleMs = Date.now();
          for (const entry of entries) {
            const key = `${entry.markerCode}:${entry.index}`;
            if (seen.has(key)) continue;
            seen.add(key); visible.push({ ...entry, visibleMs });
          }
          scheduled = false;
          if (dirty) schedule();
        });
      });
    };
    const install = () => {
      new MutationObserver(schedule).observe(document.body, { subtree: true, childList: true, characterData: true });
      schedule();
    };
    if (document.body) install(); else addEventListener("DOMContentLoaded", install, { once: true });
  });

  return { pending, clocks, nextMarkerCode, base, gate };
}
