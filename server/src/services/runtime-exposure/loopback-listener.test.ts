import net from "node:net";
import { describe, expect, it } from "vitest";

import {
  diagnoseRuntimeListenerBinds,
  formatProcAddressHex,
  listenerBindFactsForPort,
  parseProcNetListeners,
} from "./loopback-listener.js";
import { allocateExposurePortPair, type ExposurePortPair } from "./port-pair.js";

// Real header and row shape, copied from a live /proc/net/tcp{,6} on the host
// that produced the PAP-17256 failures. Port 42003 is A40B; 52003 is CB23.
const TCP_HEADER =
  "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode                                                     ";
const TCP6_HEADER =
  "  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";

function tcpRow(addrHex: string, portHex: string, state = "0A") {
  return `   0: ${addrHex}:${portHex} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000   999        0 74815359 1 0000000000000000 100 0 0 10 0`;
}

function tcp6Row(addrHex: string, portHex: string, state = "0A") {
  return `   0: ${addrHex}:${portHex} 00000000000000000000000000000000:0000 ${state} 00000000:00000000 00:00000000 00000000   999        0 74815360 2 0000000000000000 100 0 0 10 0`;
}

/** The app port from the PAP-17256 lane, and its `/proc` hex form. */
const APP_PORT = 42_003;
const portHex = (port: number) => port.toString(16).toUpperCase().padStart(4, "0");
const APP_PORT_HEX = portHex(APP_PORT);

describe("formatProcAddressHex", () => {
  it("byte-swaps IPv4 words", () => {
    expect(formatProcAddressHex("0100007F")).toBe("127.0.0.1");
    expect(formatProcAddressHex("00000000")).toBe("0.0.0.0");
    expect(formatProcAddressHex("0400007F")).toBe("127.0.0.4");
  });

  it("renders the IPv6 loopback and wildcard forms /proc actually stores", () => {
    expect(formatProcAddressHex("00000000000000000000000001000000")).toBe("::1");
    expect(formatProcAddressHex("00000000000000000000000000000000")).toBe("::");
  });
});

describe("listenerBindFactsForPort", () => {
  it("accepts an IPv4 loopback listener", () => {
    const facts = listenerBindFactsForPort(
      parseProcNetListeners(`${TCP_HEADER}\n${tcpRow("0100007F", APP_PORT_HEX)}\n`),
      [],
      APP_PORT,
    );
    expect(facts).toEqual({ present: true, loopbackOnly: true, addresses: ["127.0.0.1"] });
  });

  it("accepts an IPv6 loopback listener in the little-endian ::1 form", () => {
    const facts = listenerBindFactsForPort(
      [],
      parseProcNetListeners(
        `${TCP6_HEADER}\n${tcp6Row("00000000000000000000000001000000", APP_PORT_HEX)}\n`,
      ),
      APP_PORT,
    );
    expect(facts).toEqual({ present: true, loopbackOnly: true, addresses: ["::1"] });
  });

  it("rejects the 0.0.0.0 wildcard bind that broke every managed lane", () => {
    const facts = listenerBindFactsForPort(
      parseProcNetListeners(`${TCP_HEADER}\n${tcpRow("00000000", APP_PORT_HEX)}\n`),
      [],
      APP_PORT,
    );
    expect(facts).toEqual({ present: true, loopbackOnly: false, addresses: ["0.0.0.0"] });
  });

  it("rejects the :: wildcard bind", () => {
    const facts = listenerBindFactsForPort(
      [],
      parseProcNetListeners(
        `${TCP6_HEADER}\n${tcp6Row("00000000000000000000000000000000", APP_PORT_HEX)}\n`,
      ),
      APP_PORT,
    );
    expect(facts.loopbackOnly).toBe(false);
    expect(facts.addresses).toEqual(["::"]);
  });

  it("rejects a non-loopback unicast bind", () => {
    // 100.123.243.20 — the tailnet address, stored little-endian.
    const facts = listenerBindFactsForPort(
      parseProcNetListeners(`${TCP_HEADER}\n${tcpRow("14F37B64", APP_PORT_HEX)}\n`),
      [],
      APP_PORT,
    );
    expect(facts.loopbackOnly).toBe(false);
    expect(facts.addresses).toEqual(["100.123.243.20"]);
  });

  it("reports absent for a port with no LISTEN row", () => {
    const facts = listenerBindFactsForPort(
      // Same port, but ESTABLISHED (01) rather than LISTEN (0A).
      parseProcNetListeners(`${TCP_HEADER}\n${tcpRow("0100007F", APP_PORT_HEX, "01")}\n`),
      [],
      APP_PORT,
    );
    expect(facts).toEqual({ present: false, loopbackOnly: true, addresses: [] });
  });

  it("ignores rows for other ports", () => {
    const facts = listenerBindFactsForPort(
      parseProcNetListeners(`${TCP_HEADER}\n${tcpRow("00000000", portHex(52_003))}\n`),
      [],
      APP_PORT,
    );
    expect(facts.present).toBe(false);
  });

  it("is not loopback-only when a wildcard row accompanies a loopback row", () => {
    const facts = listenerBindFactsForPort(
      parseProcNetListeners(
        `${TCP_HEADER}\n${tcpRow("0100007F", APP_PORT_HEX)}\n${tcpRow("00000000", APP_PORT_HEX)}\n`,
      ),
      [],
      APP_PORT,
    );
    expect(facts.loopbackOnly).toBe(false);
    expect(facts.addresses).toEqual(["127.0.0.1", "0.0.0.0"]);
  });
});

describe("diagnoseRuntimeListenerBinds against live listeners", () => {
  /**
   * These tests bind real sockets, so they need real free ports -- and a fixed
   * pair cannot be assumed free. The suite previously pinned
   * `RUNTIME_EXPOSURE_APP_PORT_MIN + 900`, whose HMR companion is 52900. Both
   * that port and the whole 42000-42999 app range sit inside Linux's default
   * ephemeral range (32768-60999), so any outbound connection on a shared CI
   * runner can transiently own them. The suite then failed EADDRINUSE on a port
   * it never chose, on a run whose diff touched no networking.
   *
   * Ask the production allocator for a pair that probes free instead. That
   * shrinks the race from the whole suite duration to the gap between probe and
   * bind, and keeps the test on the same port policy the runtime uses. The gap
   * is not zero -- an ephemeral port can still be taken inside it -- so a lost
   * race retries on a different pair rather than failing the run.
   */
  const PORT_PAIR_ATTEMPTS = 5;

  function isAddressInUse(error: unknown): boolean {
    return (error as NodeJS.ErrnoException | null)?.code === "EADDRINUSE";
  }

  async function bindsOn(port: number, host: string | undefined): Promise<boolean> {
    return await new Promise<boolean>((resolve) => {
      const probe = net.createServer();
      probe.once("error", () => resolve(false));
      if (host === undefined) probe.listen(port, () => probe.close(() => resolve(true)));
      else probe.listen(port, host, () => probe.close(() => resolve(true)));
    });
  }

  /**
   * True only when the port is free on BOTH the wildcard and IPv4 loopback.
   * Neither probe alone is sufficient: these tests bind the app port on
   * 127.0.0.1 and the HMR companion on the wildcard, and the two binds fail on
   * different holders. A hostless listen is dual-stack IPv6, so it can succeed
   * while a v4-loopback-only holder still owns 127.0.0.1 -- checking only the
   * wildcard would hand out a port the app-port bind then rejects.
   */
  async function isPortBindable(port: number): Promise<boolean> {
    return (await bindsOn(port, undefined)) && (await bindsOn(port, "127.0.0.1"));
  }

  /**
   * Run `body` against an app/HMR port pair that probed free. A pair lost to an
   * ephemeral bind between probe and listen is retired for this call, so a retry
   * moves to a different pair rather than re-picking the one that just lost.
   */
  async function withFreePortPair(
    body: (pair: ExposurePortPair) => Promise<void>,
  ): Promise<void> {
    const retired = new Set<number>();
    let lastError: unknown;
    for (let attempt = 0; attempt < PORT_PAIR_ATTEMPTS; attempt += 1) {
      const pair = await allocateExposurePortPair({
        isPortAvailable: isPortBindable,
        reserved: retired,
      });
      try {
        await body(pair);
        return;
      } catch (error) {
        // Only a lost port race retries. An assertion failure is the real
        // verdict and must surface on the first attempt.
        if (!isAddressInUse(error)) throw error;
        lastError = error;
        retired.add(pair.appPort);
        retired.add(pair.hmrPort);
      }
    }
    throw lastError;
  }

  async function withListener<T>(
    port: number,
    host: string | undefined,
    body: () => Promise<T>,
  ): Promise<T> {
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      if (host === undefined) server.listen(port, () => resolve());
      else server.listen(port, host, () => resolve());
    });
    try {
      return await body();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  it("stays silent for a real loopback listener", async () => {
    await withFreePortPair(async ({ appPort }) => {
      await withListener(appPort, "127.0.0.1", async () => {
        expect(await diagnoseRuntimeListenerBinds([appPort])).toBeNull();
      });
    });
  });

  it("names the port and the wildcard address for a real 0.0.0.0 listener", async () => {
    await withFreePortPair(async ({ appPort }) => {
      await withListener(appPort, undefined, async () => {
        const diagnosis = await diagnoseRuntimeListenerBinds([appPort]);
        expect(diagnosis).toContain(`port ${appPort}`);
        // Node's hostless listen is dual-stack, so /proc shows :: and/or 0.0.0.0.
        expect(diagnosis).toMatch(/0\.0\.0\.0|::/);
        expect(diagnosis).toContain("--bind loopback");
      });
    });
  });

  it("catches the HMR companion port too, not just the app port", async () => {
    await withFreePortPair(async ({ appPort, hmrPort }) => {
      await withListener(appPort, "127.0.0.1", async () => {
        await withListener(hmrPort, undefined, async () => {
          const diagnosis = await diagnoseRuntimeListenerBinds([appPort, hmrPort]);
          expect(diagnosis).toContain(`port ${hmrPort}`);
          expect(diagnosis).not.toContain(`port ${appPort} is bound`);
        });
      });
    });
  });

  it("stays silent for a port with no listener, leaving the verdict to the broker", async () => {
    await withFreePortPair(async ({ appPort }) => {
      expect(await diagnoseRuntimeListenerBinds([appPort])).toBeNull();
    });
  });
});
