import { describe, expect, it } from "vitest";

import {
  DUPLEX_CHANNEL_DATA_NOTIFICATION,
  DUPLEX_CHANNEL_EXIT_NOTIFICATION,
  type PluginDuplexChannelCloseParams,
  type PluginDuplexChannelCloseResult,
  type PluginDuplexChannelDataParams,
  type PluginDuplexChannelExitParams,
  type PluginDuplexChannelOpenParams,
  type PluginDuplexChannelOpenResult,
  type PluginDuplexChannelStopParams,
  type PluginDuplexChannelWriteParams,
} from "./protocol.js";

// The generic duplex channel messages model the setup-token pseudo-terminal
// contract: open, write, stop, and close requests, plus data and exit
// notifications. The host owns the route identifier. The worker returns a worker
// session identifier that binds the data and the exit notification only. A close
// keys on the host route identifier, so a lost open reply still permits a
// host-keyed close.
//
// The messages are static types, so a valid payload assigns to its type and an
// invalid payload fails the type check. The `@ts-expect-error` directives make
// the compiler reject each invalid payload. The `tsc --noEmit` check validates
// the directives, so an invalid payload that the type accepts fails the build.

describe("duplex channel request schemas", () => {
  it("accepts a valid open request and its reply", () => {
    const open: PluginDuplexChannelOpenParams = {
      hostRouteId: "route-1",
      driverKey: "daytona",
      companyId: "company-1",
      environmentId: "env-1",
      providerLeaseId: "lease-1",
      command: ["paperclip-bridge"],
    };
    const reply: PluginDuplexChannelOpenResult = {
      hostRouteId: "route-1",
      workerSessionId: "ws-1",
    };
    expect(open.hostRouteId).toBe("route-1");
    expect(reply.hostRouteId).toBe("route-1");
    expect(reply.workerSessionId).toBe("ws-1");
  });

  it("rejects an open reply that omits the echoed host route identifier", () => {
    // @ts-expect-error — the open reply echoes the host route identifier.
    const reply: PluginDuplexChannelOpenResult = { workerSessionId: "ws-1" };
    expect(reply).toBeDefined();
  });

  it("rejects an open request that omits the host route identifier", () => {
    // @ts-expect-error — hostRouteId is required.
    const open: PluginDuplexChannelOpenParams = {
      driverKey: "daytona",
      companyId: "company-1",
      environmentId: "env-1",
      providerLeaseId: "lease-1",
      command: ["paperclip-bridge"],
    };
    expect(open).toBeDefined();
  });

  it("rejects an open request whose command is not a string array", () => {
    const open: PluginDuplexChannelOpenParams = {
      hostRouteId: "route-1",
      driverKey: "daytona",
      companyId: "company-1",
      environmentId: "env-1",
      providerLeaseId: "lease-1",
      // @ts-expect-error — command must be a string array.
      command: "paperclip-bridge",
    };
    expect(open).toBeDefined();
  });

  it("accepts a valid write request that carries the exact pair", () => {
    const write: PluginDuplexChannelWriteParams = {
      hostRouteId: "route-1",
      workerSessionId: "ws-1",
      data: "payload",
    };
    expect(write.data).toBe("payload");
  });

  it("rejects a write request that omits the host route identifier", () => {
    // @ts-expect-error — hostRouteId is required on a post-bind write.
    const write: PluginDuplexChannelWriteParams = {
      workerSessionId: "ws-1",
      data: "payload",
    };
    expect(write).toBeDefined();
  });

  it("rejects a write request that omits the data", () => {
    // @ts-expect-error — data is required.
    const write: PluginDuplexChannelWriteParams = {
      hostRouteId: "route-1",
      workerSessionId: "ws-1",
    };
    expect(write).toBeDefined();
  });

  it("accepts a valid stop request that carries the exact pair", () => {
    const stop: PluginDuplexChannelStopParams = {
      hostRouteId: "route-1",
      workerSessionId: "ws-1",
    };
    expect(stop.workerSessionId).toBe("ws-1");
  });

  it("rejects a stop request that omits the host route identifier", () => {
    // @ts-expect-error — hostRouteId is required on a post-bind stop.
    const stop: PluginDuplexChannelStopParams = { workerSessionId: "ws-1" };
    expect(stop).toBeDefined();
  });

  it("rejects a stop request that omits the worker session identifier", () => {
    // @ts-expect-error — workerSessionId is required.
    const stop: PluginDuplexChannelStopParams = { hostRouteId: "route-1" };
    expect(stop).toBeDefined();
  });

  it("accepts a pre-bind close request and a route-only acknowledgement", () => {
    const close: PluginDuplexChannelCloseParams = { hostRouteId: "route-1" };
    const reply: PluginDuplexChannelCloseResult = { hostRouteId: "route-1" };
    expect(close.hostRouteId).toBe("route-1");
    expect(reply.hostRouteId).toBe("route-1");
  });

  it("accepts a bound close acknowledgement that echoes both identifiers", () => {
    const reply: PluginDuplexChannelCloseResult = {
      hostRouteId: "route-1",
      workerSessionId: "ws-1",
    };
    expect(reply.workerSessionId).toBe("ws-1");
  });

  it("accepts a close request that also carries the worker session identifier", () => {
    const close: PluginDuplexChannelCloseParams = {
      hostRouteId: "route-1",
      workerSessionId: "ws-1",
    };
    expect(close.workerSessionId).toBe("ws-1");
  });

  it("rejects a close request that omits the host route identifier", () => {
    // @ts-expect-error — hostRouteId is the authoritative close key and is required.
    const close: PluginDuplexChannelCloseParams = { workerSessionId: "ws-1" };
    expect(close).toBeDefined();
  });
});

describe("duplex channel notification schemas", () => {
  it("uses the generic notification method names", () => {
    expect(DUPLEX_CHANNEL_DATA_NOTIFICATION).toBe("duplexChannel.data");
    expect(DUPLEX_CHANNEL_EXIT_NOTIFICATION).toBe("duplexChannel.exit");
  });

  it("accepts a valid data notification that carries the exact pair", () => {
    const data: PluginDuplexChannelDataParams = {
      hostRouteId: "route-1",
      workerSessionId: "ws-1",
      chunk: "output bytes",
    };
    expect(data.chunk).toBe("output bytes");
  });

  it("rejects a data notification that omits the host route identifier", () => {
    // @ts-expect-error — hostRouteId is required on a notification.
    const data: PluginDuplexChannelDataParams = {
      workerSessionId: "ws-1",
      chunk: "output bytes",
    };
    expect(data).toBeDefined();
  });

  it("rejects a data notification that omits the chunk", () => {
    // @ts-expect-error — chunk is required.
    const data: PluginDuplexChannelDataParams = {
      hostRouteId: "route-1",
      workerSessionId: "ws-1",
    };
    expect(data).toBeDefined();
  });

  it("accepts an exit notification with a numeric code and with null", () => {
    const exit: PluginDuplexChannelExitParams = {
      hostRouteId: "route-1",
      workerSessionId: "ws-1",
      exitCode: 0,
    };
    const exitNull: PluginDuplexChannelExitParams = {
      hostRouteId: "route-1",
      workerSessionId: "ws-1",
      exitCode: null,
    };
    expect(exit.exitCode).toBe(0);
    expect(exitNull.exitCode).toBeNull();
  });

  it("rejects an exit notification that omits the host route identifier", () => {
    // @ts-expect-error — hostRouteId is required on a notification.
    const exit: PluginDuplexChannelExitParams = {
      workerSessionId: "ws-1",
      exitCode: 0,
    };
    expect(exit).toBeDefined();
  });

  it("rejects an exit notification with a non-numeric, non-null exit code", () => {
    const exit: PluginDuplexChannelExitParams = {
      hostRouteId: "route-1",
      workerSessionId: "ws-1",
      // @ts-expect-error — exitCode must be a number or null.
      exitCode: "0",
    };
    expect(exit).toBeDefined();
  });
});
