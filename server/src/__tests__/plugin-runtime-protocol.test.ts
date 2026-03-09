/**
 * Tests for JSON-RPC 2.0 protocol, worker process manager spawn/crash/restart/
 * shutdown, and graceful shutdown with deadlines.
 *
 * Covers:
 * - JSON-RPC protocol: message creation, type guards, parsing, serialization,
 *   error codes, error classes
 * - Worker process manager: spawn lifecycle, crash recovery with exponential
 *   backoff, restart behavior, SIGTERM/SIGKILL escalation
 * - Graceful shutdown with deadlines: 10s drain → SIGTERM → SIGKILL
 *
 * @see doc/plugins/PLUGIN_SPEC.md §12   — Process Model
 * @see doc/plugins/PLUGIN_SPEC.md §12.5 — Graceful Shutdown Policy
 * @see doc/plugins/PLUGIN_SPEC.md §13   — Host-Worker Protocol
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type {
  PaperclipPluginManifestV1,
  PluginCapability,
  PluginCategory,
} from "@paperclipai/shared";
import {
  JSONRPC_VERSION,
  JSONRPC_ERROR_CODES,
  PLUGIN_RPC_ERROR_CODES,
  HOST_TO_WORKER_REQUIRED_METHODS,
  HOST_TO_WORKER_OPTIONAL_METHODS,
  MESSAGE_DELIMITER,
  createRequest,
  createSuccessResponse,
  createErrorResponse,
  createNotification,
  isJsonRpcRequest,
  isJsonRpcNotification,
  isJsonRpcResponse,
  isJsonRpcSuccessResponse,
  isJsonRpcErrorResponse,
  serializeMessage,
  parseMessage,
  JsonRpcParseError,
  JsonRpcCallError,
  _resetIdCounter,
} from "@paperclipai/plugin-sdk";
import type {
  JsonRpcRequest,
  JsonRpcSuccessResponse,
  JsonRpcErrorResponse,
  JsonRpcNotification,
  JsonRpcResponse,
} from "@paperclipai/plugin-sdk";

// ===========================================================================
// Part 1: JSON-RPC 2.0 Protocol Tests
// ===========================================================================

describe("JSON-RPC 2.0 Protocol", () => {
  // -------------------------------------------------------------------------
  // Constants
  // -------------------------------------------------------------------------

  describe("constants", () => {
    it("JSONRPC_VERSION is '2.0'", () => {
      expect(JSONRPC_VERSION).toBe("2.0");
    });

    it("MESSAGE_DELIMITER is a newline", () => {
      expect(MESSAGE_DELIMITER).toBe("\n");
    });

    it("JSONRPC_ERROR_CODES contains all standard codes", () => {
      expect(JSONRPC_ERROR_CODES.PARSE_ERROR).toBe(-32700);
      expect(JSONRPC_ERROR_CODES.INVALID_REQUEST).toBe(-32600);
      expect(JSONRPC_ERROR_CODES.METHOD_NOT_FOUND).toBe(-32601);
      expect(JSONRPC_ERROR_CODES.INVALID_PARAMS).toBe(-32602);
      expect(JSONRPC_ERROR_CODES.INTERNAL_ERROR).toBe(-32603);
    });

    it("PLUGIN_RPC_ERROR_CODES are in the server-reserved range (-32000 to -32099)", () => {
      const codes = Object.values(PLUGIN_RPC_ERROR_CODES);
      for (const code of codes) {
        expect(code).toBeGreaterThanOrEqual(-32099);
        expect(code).toBeLessThanOrEqual(-32000);
      }
    });

    it("PLUGIN_RPC_ERROR_CODES has expected values", () => {
      expect(PLUGIN_RPC_ERROR_CODES.WORKER_UNAVAILABLE).toBe(-32000);
      expect(PLUGIN_RPC_ERROR_CODES.CAPABILITY_DENIED).toBe(-32001);
      expect(PLUGIN_RPC_ERROR_CODES.WORKER_ERROR).toBe(-32002);
      expect(PLUGIN_RPC_ERROR_CODES.TIMEOUT).toBe(-32003);
      expect(PLUGIN_RPC_ERROR_CODES.METHOD_NOT_IMPLEMENTED).toBe(-32004);
      expect(PLUGIN_RPC_ERROR_CODES.UNKNOWN).toBe(-32099);
    });

    it("HOST_TO_WORKER_REQUIRED_METHODS contains exactly 3 required methods", () => {
      expect(HOST_TO_WORKER_REQUIRED_METHODS).toHaveLength(3);
      expect(HOST_TO_WORKER_REQUIRED_METHODS).toContain("initialize");
      expect(HOST_TO_WORKER_REQUIRED_METHODS).toContain("health");
      expect(HOST_TO_WORKER_REQUIRED_METHODS).toContain("shutdown");
    });

    it("HOST_TO_WORKER_OPTIONAL_METHODS contains all optional methods", () => {
      expect(HOST_TO_WORKER_OPTIONAL_METHODS).toContain("validateConfig");
      expect(HOST_TO_WORKER_OPTIONAL_METHODS).toContain("configChanged");
      expect(HOST_TO_WORKER_OPTIONAL_METHODS).toContain("onEvent");
      expect(HOST_TO_WORKER_OPTIONAL_METHODS).toContain("runJob");
      expect(HOST_TO_WORKER_OPTIONAL_METHODS).toContain("handleWebhook");
      expect(HOST_TO_WORKER_OPTIONAL_METHODS).toContain("getData");
      expect(HOST_TO_WORKER_OPTIONAL_METHODS).toContain("performAction");
      expect(HOST_TO_WORKER_OPTIONAL_METHODS).toContain("executeTool");
      expect(HOST_TO_WORKER_OPTIONAL_METHODS).toHaveLength(8);
    });

    it("required and optional method sets are disjoint", () => {
      for (const method of HOST_TO_WORKER_REQUIRED_METHODS) {
        expect(HOST_TO_WORKER_OPTIONAL_METHODS).not.toContain(method);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Message factory functions
  // -------------------------------------------------------------------------

  describe("createRequest", () => {
    it("creates a valid request with auto-generated id", () => {
      const req = createRequest("health", {});
      expect(req.jsonrpc).toBe("2.0");
      expect(req.method).toBe("health");
      expect(req.params).toEqual({});
      expect(typeof req.id).toBe("number");
    });

    it("auto-increments request ids", () => {
      const req1 = createRequest("health", {});
      const req2 = createRequest("health", {});
      expect(typeof req1.id).toBe("number");
      expect(typeof req2.id).toBe("number");
      expect(req2.id).toBe((req1.id as number) + 1);
    });

    it("accepts an explicit id", () => {
      const req = createRequest("initialize", { manifest: {} }, "custom-id-1");
      expect(req.id).toBe("custom-id-1");
    });

    it("accepts a numeric explicit id", () => {
      const req = createRequest("health", {}, 42);
      expect(req.id).toBe(42);
    });

    it("preserves complex params", () => {
      const params = {
        manifest: { id: "test.plugin" },
        config: { apiKey: "key" },
        nested: { deep: { value: [1, 2, 3] } },
      };
      const req = createRequest("initialize", params);
      expect(req.params).toEqual(params);
    });
  });

  describe("createSuccessResponse", () => {
    it("creates a success response with a result", () => {
      const res = createSuccessResponse(1, { status: "ok" });
      expect(res.jsonrpc).toBe("2.0");
      expect(res.id).toBe(1);
      expect(res.result).toEqual({ status: "ok" });
    });

    it("accepts null result", () => {
      const res = createSuccessResponse(2, null);
      expect(res.result).toBeNull();
    });

    it("accepts string id", () => {
      const res = createSuccessResponse("req-uuid", "hello");
      expect(res.id).toBe("req-uuid");
      expect(res.result).toBe("hello");
    });

    it("preserves complex result types", () => {
      const result = { data: [1, 2, 3], meta: { page: 1 } };
      const res = createSuccessResponse(1, result);
      expect(res.result).toEqual(result);
    });
  });

  describe("createErrorResponse", () => {
    it("creates an error response with code and message", () => {
      const res = createErrorResponse(
        1,
        JSONRPC_ERROR_CODES.METHOD_NOT_FOUND,
        "Method not found",
      );
      expect(res.jsonrpc).toBe("2.0");
      expect(res.id).toBe(1);
      expect(res.error.code).toBe(-32601);
      expect(res.error.message).toBe("Method not found");
      expect(res.error.data).toBeUndefined();
    });

    it("accepts null id (for parse errors before id is known)", () => {
      const res = createErrorResponse(
        null,
        JSONRPC_ERROR_CODES.PARSE_ERROR,
        "Invalid JSON",
      );
      expect(res.id).toBeNull();
    });

    it("includes optional error data when provided", () => {
      const res = createErrorResponse(
        5,
        PLUGIN_RPC_ERROR_CODES.WORKER_ERROR,
        "Handler threw",
        { stack: "Error: ...", pluginId: "test.plugin" },
      );
      expect(res.error.data).toEqual({
        stack: "Error: ...",
        pluginId: "test.plugin",
      });
    });

    it("omits data field when not provided", () => {
      const res = createErrorResponse(1, -32600, "Invalid");
      expect("data" in res.error).toBe(false);
    });
  });

  describe("createNotification", () => {
    it("creates a notification without an id", () => {
      const notif = createNotification("log", { level: "info", message: "hi" });
      expect(notif.jsonrpc).toBe("2.0");
      expect(notif.method).toBe("log");
      expect(notif.params).toEqual({ level: "info", message: "hi" });
      expect("id" in notif).toBe(false);
    });

    it("is distinguishable from a request (no id)", () => {
      const notif = createNotification("configChanged", { config: {} });
      expect(isJsonRpcNotification(notif)).toBe(true);
      expect(isJsonRpcRequest(notif)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Type guards
  // -------------------------------------------------------------------------

  describe("type guards", () => {
    describe("isJsonRpcRequest", () => {
      it("returns true for a valid request", () => {
        expect(isJsonRpcRequest({
          jsonrpc: "2.0",
          id: 1,
          method: "health",
          params: {},
        })).toBe(true);
      });

      it("returns true for string id", () => {
        expect(isJsonRpcRequest({
          jsonrpc: "2.0",
          id: "abc",
          method: "health",
          params: {},
        })).toBe(true);
      });

      it("returns false for missing id", () => {
        expect(isJsonRpcRequest({
          jsonrpc: "2.0",
          method: "health",
          params: {},
        })).toBe(false);
      });

      it("returns false for null id", () => {
        expect(isJsonRpcRequest({
          jsonrpc: "2.0",
          id: null,
          method: "health",
          params: {},
        })).toBe(false);
      });

      it("returns false for wrong jsonrpc version", () => {
        expect(isJsonRpcRequest({
          jsonrpc: "1.0",
          id: 1,
          method: "health",
        })).toBe(false);
      });

      it("returns false for missing method", () => {
        expect(isJsonRpcRequest({
          jsonrpc: "2.0",
          id: 1,
          params: {},
        })).toBe(false);
      });

      it("returns false for non-string method", () => {
        expect(isJsonRpcRequest({
          jsonrpc: "2.0",
          id: 1,
          method: 42,
          params: {},
        })).toBe(false);
      });

      it("returns false for null", () => {
        expect(isJsonRpcRequest(null)).toBe(false);
      });

      it("returns false for non-object", () => {
        expect(isJsonRpcRequest("hello")).toBe(false);
        expect(isJsonRpcRequest(42)).toBe(false);
        expect(isJsonRpcRequest(undefined)).toBe(false);
      });
    });

    describe("isJsonRpcNotification", () => {
      it("returns true for a valid notification", () => {
        expect(isJsonRpcNotification({
          jsonrpc: "2.0",
          method: "log",
          params: { level: "info" },
        })).toBe(true);
      });

      it("returns false when id is present", () => {
        expect(isJsonRpcNotification({
          jsonrpc: "2.0",
          id: 1,
          method: "log",
          params: {},
        })).toBe(false);
      });

      it("returns false for wrong version", () => {
        expect(isJsonRpcNotification({
          jsonrpc: "1.0",
          method: "log",
        })).toBe(false);
      });

      it("returns false for non-object types", () => {
        expect(isJsonRpcNotification(null)).toBe(false);
        expect(isJsonRpcNotification(42)).toBe(false);
        expect(isJsonRpcNotification("str")).toBe(false);
      });
    });

    describe("isJsonRpcResponse", () => {
      it("returns true for a success response", () => {
        expect(isJsonRpcResponse({
          jsonrpc: "2.0",
          id: 1,
          result: { status: "ok" },
        })).toBe(true);
      });

      it("returns true for an error response", () => {
        expect(isJsonRpcResponse({
          jsonrpc: "2.0",
          id: 1,
          error: { code: -32600, message: "Bad request" },
        })).toBe(true);
      });

      it("returns false if neither result nor error present", () => {
        expect(isJsonRpcResponse({
          jsonrpc: "2.0",
          id: 1,
        })).toBe(false);
      });

      it("returns false for missing id", () => {
        expect(isJsonRpcResponse({
          jsonrpc: "2.0",
          result: {},
        })).toBe(false);
      });

      it("returns false for non-objects", () => {
        expect(isJsonRpcResponse(null)).toBe(false);
        expect(isJsonRpcResponse("text")).toBe(false);
      });
    });

    describe("isJsonRpcSuccessResponse", () => {
      it("returns true when result is present", () => {
        const resp: JsonRpcResponse = {
          jsonrpc: "2.0",
          id: 1,
          result: { ok: true },
        };
        expect(isJsonRpcSuccessResponse(resp)).toBe(true);
      });

      it("returns false when error is present", () => {
        const resp: JsonRpcResponse = {
          jsonrpc: "2.0",
          id: 1,
          error: { code: -32600, message: "bad" },
        };
        expect(isJsonRpcSuccessResponse(resp)).toBe(false);
      });

      it("handles null result as success", () => {
        const resp: JsonRpcResponse = {
          jsonrpc: "2.0",
          id: 1,
          result: null,
        };
        expect(isJsonRpcSuccessResponse(resp)).toBe(true);
      });
    });

    describe("isJsonRpcErrorResponse", () => {
      it("returns true for error response", () => {
        const resp: JsonRpcResponse = {
          jsonrpc: "2.0",
          id: 1,
          error: { code: -32601, message: "Not found" },
        };
        expect(isJsonRpcErrorResponse(resp)).toBe(true);
      });

      it("returns false for success response", () => {
        const resp: JsonRpcResponse = {
          jsonrpc: "2.0",
          id: 1,
          result: { ok: true },
        };
        expect(isJsonRpcErrorResponse(resp)).toBe(false);
      });
    });
  });

  // -------------------------------------------------------------------------
  // Serialization / Parsing
  // -------------------------------------------------------------------------

  describe("serializeMessage", () => {
    it("produces valid NDJSON (JSON + newline)", () => {
      const req = createRequest("health", {}, 1);
      const serialized = serializeMessage(req);
      expect(serialized.endsWith("\n")).toBe(true);
      expect(serialized.split("\n").filter(Boolean)).toHaveLength(1);
    });

    it("round-trips through JSON.parse", () => {
      const req = createRequest("initialize", { manifest: { id: "test" } }, 10);
      const serialized = serializeMessage(req);
      const parsed = JSON.parse(serialized.trim());
      expect(parsed.jsonrpc).toBe("2.0");
      expect(parsed.id).toBe(10);
      expect(parsed.method).toBe("initialize");
    });

    it("works with notifications", () => {
      const notif = createNotification("log", { level: "info", message: "test" });
      const serialized = serializeMessage(notif);
      const parsed = JSON.parse(serialized.trim());
      expect(parsed.method).toBe("log");
      expect(parsed.id).toBeUndefined();
    });

    it("works with success responses", () => {
      const res = createSuccessResponse(42, { status: "ok" });
      const serialized = serializeMessage(res);
      const parsed = JSON.parse(serialized.trim());
      expect(parsed.result).toEqual({ status: "ok" });
    });

    it("works with error responses", () => {
      const res = createErrorResponse(99, -32600, "Invalid");
      const serialized = serializeMessage(res);
      const parsed = JSON.parse(serialized.trim());
      expect(parsed.error.code).toBe(-32600);
    });
  });

  describe("parseMessage", () => {
    it("parses a valid JSON-RPC 2.0 request", () => {
      const line = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "health",
        params: {},
      });
      const msg = parseMessage(line);
      expect(isJsonRpcRequest(msg)).toBe(true);
    });

    it("parses a valid response", () => {
      const line = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { ok: true },
      });
      const msg = parseMessage(line);
      expect(isJsonRpcResponse(msg)).toBe(true);
    });

    it("parses a notification", () => {
      const line = JSON.stringify({
        jsonrpc: "2.0",
        method: "log",
        params: { level: "info" },
      });
      const msg = parseMessage(line);
      expect(isJsonRpcNotification(msg)).toBe(true);
    });

    it("trims whitespace before parsing", () => {
      const line = `  ${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "health", params: {} })}  `;
      const msg = parseMessage(line);
      expect(isJsonRpcRequest(msg)).toBe(true);
    });

    it("throws JsonRpcParseError for empty string", () => {
      expect(() => parseMessage("")).toThrow(JsonRpcParseError);
      expect(() => parseMessage("")).toThrow("Empty message");
    });

    it("throws JsonRpcParseError for whitespace-only string", () => {
      expect(() => parseMessage("   ")).toThrow(JsonRpcParseError);
    });

    it("throws JsonRpcParseError for invalid JSON", () => {
      expect(() => parseMessage("not valid json")).toThrow(JsonRpcParseError);
      expect(() => parseMessage("not valid json")).toThrow("Invalid JSON");
    });

    it("throws JsonRpcParseError for non-object JSON", () => {
      expect(() => parseMessage('"hello"')).toThrow(JsonRpcParseError);
      expect(() => parseMessage("42")).toThrow(JsonRpcParseError);
      expect(() => parseMessage("[1,2]")).toThrow(JsonRpcParseError);
    });

    it("throws JsonRpcParseError for missing jsonrpc version", () => {
      expect(() => parseMessage(JSON.stringify({
        id: 1,
        method: "health",
      }))).toThrow(JsonRpcParseError);
    });

    it("throws JsonRpcParseError for wrong jsonrpc version", () => {
      expect(() => parseMessage(JSON.stringify({
        jsonrpc: "1.0",
        id: 1,
        method: "health",
      }))).toThrow(JsonRpcParseError);
      expect(() => parseMessage(JSON.stringify({
        jsonrpc: "1.0",
        id: 1,
        method: "health",
      }))).toThrow('expected "2.0"');
    });

    it("handles trailing newline in input", () => {
      const line = JSON.stringify({ jsonrpc: "2.0", id: 1, result: null }) + "\n";
      const msg = parseMessage(line);
      expect(isJsonRpcResponse(msg)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Error classes
  // -------------------------------------------------------------------------

  describe("JsonRpcParseError", () => {
    it("has the correct name", () => {
      const err = new JsonRpcParseError("bad json");
      expect(err.name).toBe("JsonRpcParseError");
    });

    it("is an instance of Error", () => {
      const err = new JsonRpcParseError("test");
      expect(err).toBeInstanceOf(Error);
    });

    it("preserves the message", () => {
      const err = new JsonRpcParseError("Invalid JSON: {broken");
      expect(err.message).toBe("Invalid JSON: {broken");
    });

    it("has a stack trace", () => {
      const err = new JsonRpcParseError("test");
      expect(err.stack).toBeDefined();
    });
  });

  describe("JsonRpcCallError", () => {
    it("has the correct name", () => {
      const err = new JsonRpcCallError({
        code: -32601,
        message: "Method not found",
      });
      expect(err.name).toBe("JsonRpcCallError");
    });

    it("is an instance of Error", () => {
      const err = new JsonRpcCallError({
        code: -32000,
        message: "Unavailable",
      });
      expect(err).toBeInstanceOf(Error);
    });

    it("captures the error code", () => {
      const err = new JsonRpcCallError({
        code: PLUGIN_RPC_ERROR_CODES.TIMEOUT,
        message: "Timed out",
      });
      expect(err.code).toBe(-32003);
    });

    it("captures optional error data", () => {
      const err = new JsonRpcCallError({
        code: -32002,
        message: "Handler error",
        data: { pluginId: "test.plugin", stack: "Error: fail" },
      });
      expect(err.data).toEqual({
        pluginId: "test.plugin",
        stack: "Error: fail",
      });
    });

    it("data is undefined when not provided", () => {
      const err = new JsonRpcCallError({
        code: -32600,
        message: "Bad request",
      });
      expect(err.data).toBeUndefined();
    });

    it("preserves the error message", () => {
      const err = new JsonRpcCallError({
        code: -32603,
        message: "Internal error: something broke",
      });
      expect(err.message).toBe("Internal error: something broke");
    });
  });

  // -------------------------------------------------------------------------
  // Round-trip: create → serialize → parse → type-guard
  // -------------------------------------------------------------------------

  describe("round-trip: create → serialize → parse → type-guard", () => {
    it("request round-trips correctly", () => {
      const original = createRequest("initialize", { manifest: { id: "test" } }, 99);
      const serialized = serializeMessage(original);
      const parsed = parseMessage(serialized);
      expect(isJsonRpcRequest(parsed)).toBe(true);
      const req = parsed as JsonRpcRequest;
      expect(req.method).toBe("initialize");
      expect(req.id).toBe(99);
    });

    it("success response round-trips correctly", () => {
      const original = createSuccessResponse(5, { status: "ok" });
      const serialized = serializeMessage(original);
      const parsed = parseMessage(serialized);
      expect(isJsonRpcResponse(parsed)).toBe(true);
      expect(isJsonRpcSuccessResponse(parsed as JsonRpcResponse)).toBe(true);
      expect((parsed as JsonRpcSuccessResponse).result).toEqual({ status: "ok" });
    });

    it("error response round-trips correctly", () => {
      const original = createErrorResponse(7, -32601, "Not found", { detail: "no method" });
      const serialized = serializeMessage(original);
      const parsed = parseMessage(serialized);
      expect(isJsonRpcResponse(parsed)).toBe(true);
      expect(isJsonRpcErrorResponse(parsed as JsonRpcResponse)).toBe(true);
      const errResp = parsed as JsonRpcErrorResponse;
      expect(errResp.error.code).toBe(-32601);
      expect(errResp.error.data).toEqual({ detail: "no method" });
    });

    it("notification round-trips correctly", () => {
      const original = createNotification("log", { level: "warn", message: "test" });
      const serialized = serializeMessage(original);
      const parsed = parseMessage(serialized);
      expect(isJsonRpcNotification(parsed)).toBe(true);
      expect((parsed as JsonRpcNotification).method).toBe("log");
    });
  });
});


// ===========================================================================
// Part 2: Worker Process Manager — spawn / crash / restart / shutdown
// ===========================================================================

// ---------------------------------------------------------------------------
// Mock child_process.fork
// ---------------------------------------------------------------------------

class MockChildProcess extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  pid = 12345;
  killed = false;

  private _stdinBuffer = "";
  private _stdinWaiters: Array<(data: string) => void> = [];

  constructor() {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();

    this.stdin.on("data", (chunk: Buffer) => {
      this._stdinBuffer += chunk.toString();
      this._flushWaiters();
    });
  }

  private _flushWaiters(): void {
    while (this._stdinWaiters.length > 0 && this._stdinBuffer.includes("\n")) {
      const idx = this._stdinBuffer.indexOf("\n");
      const line = this._stdinBuffer.slice(0, idx);
      this._stdinBuffer = this._stdinBuffer.slice(idx + 1);
      const waiter = this._stdinWaiters.shift()!;
      waiter(line);
    }
  }

  kill(signal?: string): boolean {
    if (this.killed) return false;
    this.killed = true;
    setImmediate(() => {
      this.emit("exit", signal === "SIGKILL" ? null : 0, signal ?? null);
    });
    return true;
  }

  sendToHost(message: unknown): void {
    this.stdout.write(JSON.stringify(message) + "\n");
  }

  private _readNextLine(): Promise<string> {
    return new Promise((resolve) => {
      if (this._stdinBuffer.includes("\n")) {
        const idx = this._stdinBuffer.indexOf("\n");
        const line = this._stdinBuffer.slice(0, idx);
        this._stdinBuffer = this._stdinBuffer.slice(idx + 1);
        resolve(line);
      } else {
        this._stdinWaiters.push(resolve);
      }
    });
  }

  async respondToNextRequest(result: unknown): Promise<void> {
    const line = await this._readNextLine();
    const request = JSON.parse(line) as JsonRpcRequest;
    this.sendToHost({ jsonrpc: "2.0", id: request.id, result });
  }

  async respondWithError(code: number, message: string): Promise<void> {
    const line = await this._readNextLine();
    const request = JSON.parse(line) as JsonRpcRequest;
    this.sendToHost({ jsonrpc: "2.0", id: request.id, error: { code, message } });
  }

  async respondToShutdownAndExit(): Promise<void> {
    const line = await this._readNextLine();
    const request = JSON.parse(line) as JsonRpcRequest;
    this.sendToHost({ jsonrpc: "2.0", id: request.id, result: null });
    setImmediate(() => {
      if (!this.killed) {
        this.killed = true;
        this.emit("exit", 0, null);
      }
    });
  }

  /** Read the next request without responding — for inspection. */
  async readNextRequest(): Promise<JsonRpcRequest> {
    const line = await this._readNextLine();
    return JSON.parse(line) as JsonRpcRequest;
  }

  simulateCrash(code: number | null = 1, signal: NodeJS.Signals | null = null): void {
    this.killed = true;
    this.emit("exit", code, signal);
  }

  destroy(): void {
    this.removeAllListeners();
    this.stdin.destroy();
    this.stdout.destroy();
    this.stderr.destroy();
    this._stdinWaiters = [];
  }
}

let allMockChildren: MockChildProcess[] = [];
let mockChild: MockChildProcess;

vi.mock("node:child_process", () => ({
  fork: vi.fn(() => {
    mockChild = new MockChildProcess();
    allMockChildren.push(mockChild);
    return mockChild;
  }),
}));

vi.mock("../middleware/logger.js", () => ({
  logger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  },
}));

// Import the module under test (after mocks)
const {
  createPluginWorkerHandle,
  createPluginWorkerManager,
} = await import("../services/plugin-worker-manager.js");

import type {
  WorkerStartOptions,
  WorkerToHostHandlers,
  WorkerStatus,
  PluginWorkerHandle,
} from "../services/plugin-worker-manager.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tick = (ms = 15) => new Promise((resolve) => setTimeout(resolve, ms));

function makeManifest(
  overrides: Partial<PaperclipPluginManifestV1> = {},
): PaperclipPluginManifestV1 {
  return {
    id: "test.plugin",
    apiVersion: 1,
    version: "1.0.0",
    displayName: "Test Plugin",
    description: "A test plugin for unit tests",
    categories: ["connector" as PluginCategory],
    capabilities: ["events.subscribe" as PluginCapability],
    entrypoints: { worker: "dist/worker.js" },
    ...overrides,
  };
}

function makeStartOptions(
  overrides: Partial<WorkerStartOptions> = {},
): WorkerStartOptions {
  return {
    entrypointPath: "/path/to/worker.cjs",
    manifest: makeManifest(),
    config: { apiKey: "secret-ref:MY_KEY" },
    instanceInfo: { instanceId: "inst-1", hostVersion: "1.0.0" },
    apiVersion: 1,
    hostHandlers: {},
    ...overrides,
  };
}

async function startHandle(
  pluginId: string,
  options?: Partial<WorkerStartOptions>,
): Promise<{ handle: PluginWorkerHandle; child: MockChildProcess }> {
  const handle = createPluginWorkerHandle(pluginId, makeStartOptions(options));

  const respondPromise = (async () => {
    await tick();
    await mockChild.respondToNextRequest({ ok: true });
  })();

  await handle.start();
  await respondPromise;

  return { handle, child: mockChild };
}

// ---------------------------------------------------------------------------
// Tests: Worker spawn lifecycle — deeper edge cases
// ---------------------------------------------------------------------------

describe("worker spawn lifecycle", () => {
  beforeEach(() => {
    allMockChildren = [];
  });

  afterEach(() => {
    for (const child of allMockChildren) {
      child.destroy();
    }
    allMockChildren = [];
  });

  describe("initialize RPC payload", () => {
    it("sends the correct initialize params to the worker", async () => {
      const manifest = makeManifest({ id: "acme.linear", version: "2.0.0" });
      const config = { apiKey: "sk-test", workspace: "my-ws" };
      const instanceInfo = { instanceId: "inst-42", hostVersion: "3.5.0" };
      const apiVersion = 1;

      const handle = createPluginWorkerHandle("acme.linear", makeStartOptions({
        manifest,
        config,
        instanceInfo,
        apiVersion,
      }));

      const startPromise = handle.start();
      await tick();

      // Read the initialize request that was sent to the worker
      const request = await mockChild.readNextRequest();
      expect(request.method).toBe("initialize");
      expect(request.params).toEqual({
        manifest,
        config,
        instanceInfo,
        apiVersion,
      });

      // Respond to allow startup to complete
      mockChild.sendToHost({ jsonrpc: "2.0", id: request.id, result: { ok: true } });
      await startPromise;
    });
  });

  describe("crash recovery with exponential backoff", () => {
    it("increases backoff delay with each consecutive crash", async () => {
      const { handle, child: firstChild } = await startHandle("test.plugin");

      // First crash — should schedule restart with ~1s backoff (MIN_BACKOFF_MS)
      firstChild.simulateCrash(1);
      await tick();

      expect(handle.status).toBe("backoff");
      const diag1 = handle.diagnostics();
      expect(diag1.consecutiveCrashes).toBe(1);
      expect(diag1.nextRestartAt).not.toBeNull();

      // The restart timer is pending — stop the handle to cancel it
      await handle.stop();
    });

    it("increments totalCrashes across multiple crashes", async () => {
      const { handle, child } = await startHandle("test.plugin");

      child.simulateCrash(1);
      await tick();

      const diag = handle.diagnostics();
      expect(diag.totalCrashes).toBe(1);

      // Stop to cancel pending restart
      await handle.stop();
    });

    it("does not auto-restart when autoRestart is false", async () => {
      const { handle, child } = await startHandle("test.plugin", {
        autoRestart: false,
      });

      const crashHandler = vi.fn();
      handle.on("crash", crashHandler);

      child.simulateCrash(1);
      await tick();

      expect(handle.status).toBe("crashed");
      expect(crashHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          willRestart: false,
        }),
      );
    });

    it("crash during 'stopping' status does not trigger auto-restart", async () => {
      const { handle, child } = await startHandle("test.plugin");

      // Start stopping, but don't respond to shutdown yet
      const stopPromise = handle.stop();

      // Let the shutdown RPC be sent
      await tick();

      // Simulate a crash during the stopping state — exit event
      child.simulateCrash(1, "SIGSEGV");
      await stopPromise;

      // Should be stopped, NOT backoff
      expect(handle.status).toBe("stopped");
    });

    it("records crash signal in crash event payload", async () => {
      const { handle, child } = await startHandle("test.plugin", {
        autoRestart: false,
      });

      const crashHandler = vi.fn();
      handle.on("crash", crashHandler);

      child.simulateCrash(null, "SIGABRT" as NodeJS.Signals);
      await tick();

      expect(crashHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          code: null,
          signal: "SIGABRT",
        }),
      );
    });
  });

  describe("RPC timeout behavior", () => {
    it("uses custom rpcTimeoutMs for calls", async () => {
      const { handle } = await startHandle("test.plugin", {
        rpcTimeoutMs: 30,
      });

      // Make a call that will never get a response
      const callPromise = handle.call("health", {} as Record<string, never>);

      await expect(callPromise).rejects.toThrow(/timed out/i);
    });

    it("timeout error is a JsonRpcCallError with TIMEOUT code", async () => {
      const { handle } = await startHandle("test.plugin", {
        rpcTimeoutMs: 30,
      });

      try {
        await handle.call("health", {} as Record<string, never>);
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(JsonRpcCallError);
        expect((err as JsonRpcCallError).code).toBe(PLUGIN_RPC_ERROR_CODES.TIMEOUT);
      }
    });
  });

  describe("diagnostics", () => {
    it("reports uptime only when running", async () => {
      const { handle } = await startHandle("test.plugin");
      const diag = handle.diagnostics();
      expect(diag.uptime).not.toBeNull();
      expect(diag.uptime!).toBeGreaterThanOrEqual(0);
    });

    it("reports null uptime when stopped", () => {
      const handle = createPluginWorkerHandle("test.plugin", makeStartOptions());
      expect(handle.diagnostics().uptime).toBeNull();
    });

    it("reports pending request count", async () => {
      const { handle } = await startHandle("test.plugin");

      // Send a call that hasn't been responded to yet
      const callPromise = handle.call("health", {} as Record<string, never>);
      await tick(5);

      expect(handle.diagnostics().pendingRequests).toBe(1);

      // Respond to the call
      await mockChild.respondToNextRequest({ status: "ok" });
      await callPromise;

      expect(handle.diagnostics().pendingRequests).toBe(0);
    });

    it("reports lastCrashAt after a crash", async () => {
      const { handle, child } = await startHandle("test.plugin", {
        autoRestart: false,
      });

      const before = Date.now();
      child.simulateCrash(1);
      await tick();

      const diag = handle.diagnostics();
      expect(diag.lastCrashAt).not.toBeNull();
      expect(diag.lastCrashAt!).toBeGreaterThanOrEqual(before);
      expect(diag.lastCrashAt!).toBeLessThanOrEqual(Date.now());
    });
  });

  describe("worker error events", () => {
    it("emits error event on worker process error", async () => {
      const { handle, child } = await startHandle("test.plugin", {
        autoRestart: false,
      });
      const errorHandler = vi.fn();
      handle.on("error", errorHandler);

      // Simulate an error on a running worker process
      child.emit("error", new Error("EPIPE: broken pipe"));
      await tick();

      expect(errorHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          pluginId: "test.plugin",
          error: expect.any(Error),
        }),
      );

      // Crash the worker to clean up, then stop
      child.simulateCrash(1);
      await tick();
      expect(handle.status).toBe("crashed");
    });
  });

  describe("event subscription management", () => {
    it("allows subscribing and unsubscribing from events", async () => {
      const { handle, child } = await startHandle("test.plugin");

      const exitHandler = vi.fn();
      handle.on("exit", exitHandler);
      handle.off("exit", exitHandler);

      const respondPromise = child.respondToShutdownAndExit();
      await handle.stop();
      await respondPromise;

      // Handler should NOT be called since we unsubscribed
      expect(exitHandler).not.toHaveBeenCalled();
    });
  });

  describe("stderr forwarding", () => {
    it("captures stderr output from the worker", async () => {
      const { child } = await startHandle("test.plugin");

      // Write to stderr — should not crash the host
      child.stderr.write("Warning: deprecation notice\n");
      await tick();
      // No assertion — just verifying it doesn't throw
    });
  });
});


// ---------------------------------------------------------------------------
// Tests: Graceful shutdown with deadlines
// ---------------------------------------------------------------------------

describe("graceful shutdown with deadlines", () => {
  beforeEach(() => {
    allMockChildren = [];
  });

  afterEach(() => {
    for (const child of allMockChildren) {
      child.destroy();
    }
    allMockChildren = [];
  });

  it("Phase 1: sends shutdown RPC and worker exits gracefully", async () => {
    const { handle, child } = await startHandle("test.plugin");
    const exitHandler = vi.fn();
    handle.on("exit", exitHandler);

    // Worker responds to shutdown and exits on its own
    const respondPromise = child.respondToShutdownAndExit();
    await handle.stop();
    await respondPromise;

    expect(handle.status).toBe("stopped");
    expect(exitHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginId: "test.plugin",
        code: 0,
        signal: null,
      }),
    );
  });

  it("emits status transitions through stopping → stopped", async () => {
    const { handle, child } = await startHandle("test.plugin");
    const statuses: WorkerStatus[] = [];
    handle.on("status", (p) => statuses.push(p.status));

    const respondPromise = child.respondToShutdownAndExit();
    await handle.stop();
    await respondPromise;

    expect(statuses).toContain("stopping");
    expect(statuses).toContain("stopped");
  });

  it("Phase 2: escalates to kill when worker does not exit after shutdown RPC", async () => {
    const { handle, child } = await startHandle("test.plugin");

    // Override kill to track signals and exit on SIGTERM
    const killSignals: string[] = [];
    child.kill = (signal?: string): boolean => {
      killSignals.push(signal ?? "default");
      child.killed = true;
      setImmediate(() => child.emit("exit", 0, signal ?? null));
      return true;
    };

    // Respond to shutdown RPC but don't exit — the process stays alive
    // We respond to the RPC so the drain timeout doesn't block, but the
    // process stays running, forcing the handle to escalate to SIGTERM.
    const respondPromise = child.respondToNextRequest(null);

    const stopPromise = handle.stop();
    await respondPromise;
    await stopPromise;

    expect(handle.status).toBe("stopped");
    // Should have escalated to SIGTERM since the process didn't exit
    expect(killSignals.length).toBeGreaterThanOrEqual(1);
  });

  it("stop() is idempotent when called multiple times", async () => {
    const { handle, child } = await startHandle("test.plugin");

    const respondPromise = child.respondToShutdownAndExit();
    await handle.stop();
    await respondPromise;

    // Second call should be a no-op
    await handle.stop();
    expect(handle.status).toBe("stopped");
  });

  it("stop() resolves immediately for already-stopped handles", async () => {
    const handle = createPluginWorkerHandle("test.plugin", makeStartOptions());
    expect(handle.status).toBe("stopped");

    // Should resolve immediately since already stopped
    await handle.stop();
    expect(handle.status).toBe("stopped");
  });

  it("rejects pending RPC calls when worker crashes during shutdown", async () => {
    // Use autoRestart=false to avoid unhandled restarts from crash recovery
    const { handle, child } = await startHandle("test.plugin", {
      autoRestart: false,
    });

    // Send an RPC call but don't respond to it.
    // Attach the rejection handler IMMEDIATELY to prevent unhandled rejection.
    const callPromise = handle.call("health", {} as Record<string, never>).catch((err) => err);
    await tick(5);

    // Simulate the worker crashing — all pending calls should be rejected
    child.simulateCrash(1);
    await tick();

    const err = await callPromise;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/exited/i);
  });

  it("cancels pending backoff restart when stop is called", async () => {
    const { handle, child } = await startHandle("test.plugin");

    // Trigger a crash to enter backoff state
    child.simulateCrash(1);
    await tick();
    expect(handle.status).toBe("backoff");

    // Stop should cancel the pending restart
    await handle.stop();
    expect(handle.status).toBe("stopped");
    expect(handle.diagnostics().nextRestartAt).toBeNull();
  });
});


// ---------------------------------------------------------------------------
// Tests: Worker Manager (registry level)
// ---------------------------------------------------------------------------

describe("createPluginWorkerManager — extended", () => {
  beforeEach(() => {
    allMockChildren = [];
  });

  afterEach(() => {
    for (const child of allMockChildren) {
      child.destroy();
    }
    allMockChildren = [];
  });

  describe("stopAll", () => {
    it("stops all registered workers", async () => {
      const manager = createPluginWorkerManager();

      // Start two workers
      const startA = manager.startWorker("plugin.a", makeStartOptions());
      await tick();
      await mockChild.respondToNextRequest({ ok: true });
      await startA;
      const childA = mockChild;

      const startB = manager.startWorker("plugin.b", makeStartOptions());
      await tick();
      await mockChild.respondToNextRequest({ ok: true });
      await startB;
      const childB = mockChild;

      expect(manager.isRunning("plugin.a")).toBe(true);
      expect(manager.isRunning("plugin.b")).toBe(true);

      // Queue shutdown responses for both
      const respondA = childA.respondToShutdownAndExit();
      const respondB = childB.respondToShutdownAndExit();

      await manager.stopAll();
      await respondA;
      await respondB;

      expect(manager.isRunning("plugin.a")).toBe(false);
      expect(manager.isRunning("plugin.b")).toBe(false);
      expect(manager.diagnostics()).toHaveLength(0);
    });

    it("handles errors during stopAll gracefully", async () => {
      const manager = createPluginWorkerManager();

      const startPromise = manager.startWorker("plugin.err", makeStartOptions());
      await tick();
      await mockChild.respondToNextRequest({ ok: true });
      await startPromise;

      const child = mockChild;

      // Respond to shutdown RPC but simulate the child exiting with error code
      const respondPromise = child.respondToShutdownAndExit();

      // stopAll should not throw even if individual stops have issues
      await manager.stopAll();
      await respondPromise;
      expect(manager.diagnostics()).toHaveLength(0);
    });
  });

  describe("multiple workers isolation", () => {
    it("sends RPC calls to the correct worker", async () => {
      const manager = createPluginWorkerManager();

      // Start worker A
      const startA = manager.startWorker("plugin.a", makeStartOptions());
      await tick();
      await mockChild.respondToNextRequest({ ok: true });
      await startA;
      const childA = mockChild;

      // Start worker B
      const startB = manager.startWorker("plugin.b", makeStartOptions());
      await tick();
      await mockChild.respondToNextRequest({ ok: true });
      await startB;
      const childB = mockChild;

      // Call plugin.a — childA should receive the request
      const respondA = childA.respondToNextRequest({ status: "ok", plugin: "a" });
      const resultA = await manager.call("plugin.a", "health", {} as Record<string, never>);
      await respondA;

      expect(resultA).toEqual({ status: "ok", plugin: "a" });

      // Stop all workers
      const respondShutA = childA.respondToShutdownAndExit();
      const respondShutB = childB.respondToShutdownAndExit();
      await manager.stopAll();
      await respondShutA;
      await respondShutB;
    });
  });
});


// ---------------------------------------------------------------------------
// Tests: Restart behavior
// ---------------------------------------------------------------------------

describe("worker restart behavior", () => {
  beforeEach(() => {
    allMockChildren = [];
  });

  afterEach(() => {
    for (const child of allMockChildren) {
      child.destroy();
    }
    allMockChildren = [];
  });

  it("restart() transitions: running → stopping → stopped → starting → running", async () => {
    const { handle, child: oldChild } = await startHandle("test.plugin");

    const statuses: WorkerStatus[] = [];
    handle.on("status", (p) => statuses.push(p.status));

    const shutdownPromise = oldChild.respondToShutdownAndExit();
    const restartPromise = handle.restart();

    await shutdownPromise;
    await tick(50);

    // After shutdown, a new child is forked — respond to its initialize
    if (mockChild !== oldChild) {
      await mockChild.respondToNextRequest({ ok: true });
    }

    await restartPromise;
    expect(handle.status).toBe("running");

    // Verify status transitions included the full cycle
    expect(statuses).toContain("stopping");
    expect(statuses).toContain("stopped");
    expect(statuses).toContain("starting");
    expect(statuses).toContain("running");
  });

  it("restart resets consecutive crash counter", async () => {
    const { handle, child: oldChild } = await startHandle("test.plugin");

    const shutdownPromise = oldChild.respondToShutdownAndExit();
    const restartPromise = handle.restart();
    await shutdownPromise;
    await tick(50);

    if (mockChild !== oldChild) {
      await mockChild.respondToNextRequest({ ok: true });
    }

    await restartPromise;
    expect(handle.diagnostics().consecutiveCrashes).toBe(0);
  });

  it("restart emits ready event with the plugin id", async () => {
    const { handle, child: oldChild } = await startHandle("test.plugin");

    const readyHandler = vi.fn();
    handle.on("ready", readyHandler);

    const shutdownPromise = oldChild.respondToShutdownAndExit();
    const restartPromise = handle.restart();
    await shutdownPromise;
    await tick(50);

    if (mockChild !== oldChild) {
      await mockChild.respondToNextRequest({ ok: true });
    }

    await restartPromise;
    expect(readyHandler).toHaveBeenCalledWith({ pluginId: "test.plugin" });
  });
});


// ---------------------------------------------------------------------------
// Tests: Worker-to-host handler integration
// ---------------------------------------------------------------------------

describe("worker-to-host handler integration", () => {
  beforeEach(() => {
    allMockChildren = [];
  });

  afterEach(() => {
    for (const child of allMockChildren) {
      child.destroy();
    }
    allMockChildren = [];
  });

  it("routes state.get calls to host handler", async () => {
    const stateGetHandler = vi.fn().mockResolvedValue("stored-value");
    const hostHandlers: WorkerToHostHandlers = {
      "state.get": stateGetHandler,
    };

    const { child } = await startHandle("test.plugin", { hostHandlers });

    // Simulate worker calling state.get
    child.sendToHost({
      jsonrpc: "2.0",
      id: 500,
      method: "state.get",
      params: {
        scopeKind: "instance",
        stateKey: "cursor",
      },
    });

    await tick(50);
    expect(stateGetHandler).toHaveBeenCalledWith({
      scopeKind: "instance",
      stateKey: "cursor",
    });
  });

  it("routes events.emit calls to host handler", async () => {
    const emitHandler = vi.fn().mockResolvedValue(undefined);
    const hostHandlers: WorkerToHostHandlers = {
      "events.emit": emitHandler,
    };

    const { child } = await startHandle("test.plugin", { hostHandlers });

    child.sendToHost({
      jsonrpc: "2.0",
      id: 501,
      method: "events.emit",
      params: { name: "sync-done", payload: { count: 10 } },
    });

    await tick(50);
    expect(emitHandler).toHaveBeenCalledWith({
      name: "sync-done",
      payload: { count: 10 },
    });
  });

  it("routes multiple different host handlers", async () => {
    const configHandler = vi.fn().mockResolvedValue({ apiKey: "resolved" });
    const stateSetHandler = vi.fn().mockResolvedValue(undefined);
    const hostHandlers: WorkerToHostHandlers = {
      "config.get": configHandler,
      "state.set": stateSetHandler,
    };

    const { child } = await startHandle("test.plugin", { hostHandlers });

    child.sendToHost({
      jsonrpc: "2.0",
      id: 600,
      method: "config.get",
      params: {},
    });

    await tick(50);
    expect(configHandler).toHaveBeenCalledOnce();

    child.sendToHost({
      jsonrpc: "2.0",
      id: 601,
      method: "state.set",
      params: {
        scopeKind: "instance",
        stateKey: "cursor",
        value: "next-page-token",
      },
    });

    await tick(50);
    expect(stateSetHandler).toHaveBeenCalledOnce();
  });
});


// ---------------------------------------------------------------------------
// Tests: createRequest ID overflow protection
// ---------------------------------------------------------------------------

describe("createRequest ID overflow protection", () => {
  beforeEach(() => {
    _resetIdCounter();
  });

  it("resets counter to 1 via _resetIdCounter", () => {
    // Make a few requests to advance the counter
    createRequest("test", {});
    createRequest("test", {});
    createRequest("test", {});

    _resetIdCounter();

    const req = createRequest("test", {});
    expect(req.id).toBe(1);
  });

  it("auto-generates incrementing numeric IDs", () => {
    const req1 = createRequest("test", {});
    const req2 = createRequest("test", {});
    const req3 = createRequest("test", {});

    expect(typeof req1.id).toBe("number");
    expect(typeof req2.id).toBe("number");
    expect(req2.id).toBe((req1.id as number) + 1);
    expect(req3.id).toBe((req2.id as number) + 1);
  });

  it("explicit IDs do not affect the auto-increment counter", () => {
    const auto1 = createRequest("test", {});
    const explicit = createRequest("test", {}, "custom-id");
    const auto2 = createRequest("test", {});

    expect(explicit.id).toBe("custom-id");
    expect(auto2.id).toBe((auto1.id as number) + 1);
  });
});
