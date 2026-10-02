import net from "node:net";
import { describe, expect, it } from "vitest";

import {
  diagnoseRuntimeListenerBinds,
  formatProcAddressHex,
  listenerBindFactsForPort,
  parseProcNetListeners,
} from "./loopback-listener.js";

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

const describeLiveListeners = process.platform === "linux" ? describe : describe.skip;

describeLiveListeners("diagnoseRuntimeListenerBinds against live listeners", () => {
  async function withListener<T>(
    host: string | undefined,
    body: (port: number) => Promise<T>,
  ): Promise<T> {
    const server = net.createServer();
    const port = await new Promise<number>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      const onListening = () => {
        server.off("error", onError);
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("live listener did not expose a TCP port"));
          return;
        }
        resolve(address.port);
      };
      server.once("error", onError);
      if (host === undefined) server.listen(0, onListening);
      else server.listen(0, host, onListening);
    });
    try {
      return await body(port);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  it("stays silent for a real loopback listener", async () => {
    await withListener("127.0.0.1", async (appPort) => {
      expect(await diagnoseRuntimeListenerBinds([appPort])).toBeNull();
    });
  });

  it("names the port and the wildcard address for a real 0.0.0.0 listener", async () => {
    await withListener(undefined, async (appPort) => {
      const diagnosis = await diagnoseRuntimeListenerBinds([appPort]);
      expect(diagnosis).toContain(`port ${appPort}`);
      // Node's hostless listen is dual-stack, so /proc shows :: and/or 0.0.0.0.
      expect(diagnosis).toMatch(/0\.0\.0\.0|::/);
      expect(diagnosis).toContain("--bind loopback");
    });
  });

  it("catches the HMR companion port too, not just the app port", async () => {
    await withListener("127.0.0.1", async (appPort) => {
      await withListener(undefined, async (hmrPort) => {
        const diagnosis = await diagnoseRuntimeListenerBinds([appPort, hmrPort]);
        expect(diagnosis).toContain(`port ${hmrPort}`);
        expect(diagnosis).not.toContain(`port ${appPort} is bound`);
      });
    });
  });

  it("stays silent for a port with no listener, leaving the verdict to the broker", async () => {
    const unusedPort = await withListener("127.0.0.1", async (port) => port);
    expect(await diagnoseRuntimeListenerBinds([unusedPort])).toBeNull();
  });
});
