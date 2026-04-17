import { describe, expect, it } from "vitest";
import {
  detectTransport,
  fromRows,
  toRows,
  type McpServersMap,
} from "./McpServersEditor";

describe("detectTransport", () => {
  it("returns 'stdio' when no type field is present", () => {
    expect(detectTransport({ command: "node", args: [] })).toBe("stdio");
  });

  it("returns 'sse' for type sse", () => {
    expect(detectTransport({ type: "sse", url: "http://localhost/sse" })).toBe("sse");
  });

  it("returns 'http' for type http", () => {
    expect(detectTransport({ type: "http", url: "http://localhost/mcp" })).toBe("http");
  });

  it("maps legacy type 'url' to 'http'", () => {
    expect(detectTransport({ type: "url", url: "http://localhost/mcp" })).toBe("http");
  });

  it("returns 'stdio' for unknown type values", () => {
    expect(detectTransport({ type: "unknown" })).toBe("stdio");
  });
});

describe("toRows", () => {
  it("returns empty array for undefined", () => {
    expect(toRows(undefined)).toEqual([]);
  });

  it("returns empty array for empty object", () => {
    expect(toRows({} as McpServersMap)).toEqual([]);
  });

  it("parses a stdio server", () => {
    const servers: McpServersMap = {
      "my-server": { command: "node", args: ["server.js", "--stdio"] },
    };
    const rows = toRows(servers);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("my-server");
    expect(rows[0].transport).toBe("stdio");
    expect(rows[0].command).toBe("node");
    expect(rows[0].args).toBe("server.js\n--stdio");
  });

  it("parses an SSE server", () => {
    const servers: McpServersMap = {
      "sse-server": { type: "sse", url: "http://localhost:3099/sse" },
    };
    const rows = toRows(servers);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("sse-server");
    expect(rows[0].transport).toBe("sse");
    expect(rows[0].url).toBe("http://localhost:3099/sse");
  });

  it("parses an HTTP streamable server", () => {
    const servers: McpServersMap = {
      "http-server": { type: "http", url: "http://localhost:3099/mcp" },
    };
    const rows = toRows(servers);
    expect(rows).toHaveLength(1);
    expect(rows[0].transport).toBe("http");
    expect(rows[0].url).toBe("http://localhost:3099/mcp");
  });

  it("parses env vars and adds trailing empty row", () => {
    const servers: McpServersMap = {
      "with-env": {
        command: "node",
        args: [],
        env: { API_KEY: "secret", DEBUG: "true" },
      },
    };
    const rows = toRows(servers);
    expect(rows[0].envRows).toHaveLength(3); // 2 real + 1 trailing empty
    expect(rows[0].envRows[0]).toEqual({ key: "API_KEY", value: "secret" });
    expect(rows[0].envRows[1]).toEqual({ key: "DEBUG", value: "true" });
    expect(rows[0].envRows[2]).toEqual({ key: "", value: "" });
  });
});

describe("fromRows", () => {
  it("returns undefined for empty rows", () => {
    expect(fromRows([])).toBeUndefined();
  });

  it("skips stdio rows with empty command", () => {
    const rows = [{
      uid: "1",
      name: "broken",
      transport: "stdio" as const,
      command: "  ",
      args: "",
      url: "",
      envRows: [{ key: "", value: "" }],
      open: true,
    }];
    expect(fromRows(rows)).toBeUndefined();
  });

  it("skips network rows with empty url", () => {
    const rows = [{
      uid: "1",
      name: "broken-sse",
      transport: "sse" as const,
      command: "",
      args: "",
      url: "",
      envRows: [{ key: "", value: "" }],
      open: true,
    }, {
      uid: "2",
      name: "broken-http",
      transport: "http" as const,
      command: "",
      args: "",
      url: "  ",
      envRows: [{ key: "", value: "" }],
      open: true,
    }];
    expect(fromRows(rows)).toBeUndefined();
  });

  it("skips rows with empty names", () => {
    const rows = toRows(undefined);
    // Add a row with no name
    rows.push({
      uid: "test",
      name: "  ",
      transport: "stdio",
      command: "node",
      args: "",
      url: "",
      envRows: [{ key: "", value: "" }],
      open: true,
    });
    expect(fromRows(rows)).toBeUndefined();
  });

  it("serializes a stdio server correctly", () => {
    const rows = [{
      uid: "1",
      name: "my-server",
      transport: "stdio" as const,
      command: "npx",
      args: "ts-node\nserver.ts\n--stdio",
      url: "",
      envRows: [{ key: "", value: "" }],
      open: true,
    }];
    const result = fromRows(rows);
    expect(result).toEqual({
      "my-server": {
        command: "npx",
        args: ["ts-node", "server.ts", "--stdio"],
      },
    });
  });

  it("serializes an SSE server with type 'sse'", () => {
    const rows = [{
      uid: "1",
      name: "sse-server",
      transport: "sse" as const,
      command: "",
      args: "",
      url: "http://localhost:3099/sse",
      envRows: [{ key: "", value: "" }],
      open: true,
    }];
    const result = fromRows(rows);
    expect(result).toEqual({
      "sse-server": {
        type: "sse",
        url: "http://localhost:3099/sse",
      },
    });
  });

  it("serializes HTTP streamable server with type 'http' (not 'url')", () => {
    const rows = [{
      uid: "1",
      name: "http-server",
      transport: "http" as const,
      command: "",
      args: "",
      url: "http://localhost:3099/mcp",
      envRows: [{ key: "", value: "" }],
      open: true,
    }];
    const result = fromRows(rows);
    expect(result).toEqual({
      "http-server": {
        type: "http",
        url: "http://localhost:3099/mcp",
      },
    });
    // Must NOT produce type: "url" — Claude Code rejects it
    expect((result as unknown as Record<string, Record<string, unknown>>)["http-server"].type).toBe("http");
  });

  it("includes env vars only when non-empty", () => {
    const rows = [{
      uid: "1",
      name: "with-env",
      transport: "stdio" as const,
      command: "node",
      args: "server.js",
      url: "",
      envRows: [
        { key: "API_KEY", value: "secret" },
        { key: "", value: "" }, // trailing empty — should be ignored
      ],
      open: true,
    }];
    const result = fromRows(rows)!;
    expect(result["with-env"]).toEqual({
      command: "node",
      args: ["server.js"],
      env: { API_KEY: "secret" },
    });
  });

  it("omits env when all rows are empty", () => {
    const rows = [{
      uid: "1",
      name: "no-env",
      transport: "sse" as const,
      command: "",
      args: "",
      url: "http://localhost/sse",
      envRows: [{ key: "", value: "" }],
      open: true,
    }];
    const result = fromRows(rows)!;
    expect(result["no-env"]).toEqual({ type: "sse", url: "http://localhost/sse" });
    expect("env" in result["no-env"]).toBe(false);
  });

  it("preserves commas inside arguments", () => {
    const rows = [{
      uid: "1",
      name: "comma-args",
      transport: "stdio" as const,
      command: "node",
      args: "/tmp/my,folder\n--config=a,b",
      url: "",
      envRows: [{ key: "", value: "" }],
      open: true,
    }];
    const result = fromRows(rows)!;
    expect(result["comma-args"]).toEqual({
      command: "node",
      args: ["/tmp/my,folder", "--config=a,b"],
    });
  });

  it("round-trips a mixed config correctly", () => {
    const original: McpServersMap = {
      "stdio-server": { command: "node", args: ["index.js"], env: { PORT: "8080" } },
      "sse-server": { type: "sse", url: "http://localhost:4000/sse" },
      "http-server": { type: "http", url: "http://localhost:5000/mcp" },
    };
    const rows = toRows(original);
    const result = fromRows(rows);
    expect(result).toEqual(original);
  });
});
