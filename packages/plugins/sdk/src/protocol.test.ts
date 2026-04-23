import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  JSONRPC_VERSION,
  JSONRPC_ERROR_CODES,
  PLUGIN_RPC_ERROR_CODES,
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
} from "./protocol.js";

// Reset auto-increment ID counter before each test to keep assertions deterministic
beforeEach(() => {
  _resetIdCounter();
});
afterEach(() => {
  _resetIdCounter();
});

// ============================================================================
// Constants
// ============================================================================

describe("constants", () => {
  it("JSONRPC_VERSION is '2.0'", () => {
    expect(JSONRPC_VERSION).toBe("2.0");
  });

  it("MESSAGE_DELIMITER is a newline character", () => {
    expect(MESSAGE_DELIMITER).toBe("\n");
  });

  it("JSONRPC_ERROR_CODES includes standard codes", () => {
    expect(JSONRPC_ERROR_CODES).toHaveProperty("PARSE_ERROR");
    expect(JSONRPC_ERROR_CODES).toHaveProperty("INVALID_REQUEST");
    expect(JSONRPC_ERROR_CODES).toHaveProperty("METHOD_NOT_FOUND");
    expect(JSONRPC_ERROR_CODES).toHaveProperty("INVALID_PARAMS");
    expect(JSONRPC_ERROR_CODES).toHaveProperty("INTERNAL_ERROR");
  });

  it("PLUGIN_RPC_ERROR_CODES has numeric values", () => {
    for (const value of Object.values(PLUGIN_RPC_ERROR_CODES)) {
      expect(typeof value).toBe("number");
    }
  });
});

// ============================================================================
// createRequest
// ============================================================================

describe("createRequest", () => {
  it("returns a message with jsonrpc='2.0'", () => {
    const req = createRequest("ping", {});
    expect(req.jsonrpc).toBe("2.0");
  });

  it("includes the method name", () => {
    const req = createRequest("worker.initialize", { version: "1.0" });
    expect(req.method).toBe("worker.initialize");
  });

  it("includes the params", () => {
    const params = { foo: "bar", count: 42 };
    const req = createRequest("someMethod", params);
    expect(req.params).toEqual(params);
  });

  it("auto-assigns an id starting at 1", () => {
    const req = createRequest("ping", {});
    expect(req.id).toBe(1);
  });

  it("auto-increments the id for each call", () => {
    const first = createRequest("ping", {});
    const second = createRequest("pong", {});
    const third = createRequest("ping", {});
    expect(first.id).toBe(1);
    expect(second.id).toBe(2);
    expect(third.id).toBe(3);
  });

  it("accepts an explicit numeric id", () => {
    const req = createRequest("ping", {}, 99);
    expect(req.id).toBe(99);
  });

  it("accepts an explicit string id", () => {
    const req = createRequest("ping", {}, "custom-id");
    expect(req.id).toBe("custom-id");
  });

  it("does NOT advance the counter when an explicit id is provided", () => {
    createRequest("a", {}, 99);
    const auto = createRequest("b", {});
    // Counter should still be at 1 because first call used explicit id
    expect(auto.id).toBe(1);
  });

  it("accepts null params", () => {
    const req = createRequest("ping", null);
    expect(req.params).toBeNull();
  });
});

// ============================================================================
// _resetIdCounter
// ============================================================================

describe("_resetIdCounter", () => {
  it("resets the counter so the next auto-id is 1", () => {
    createRequest("a", {});
    createRequest("b", {});
    _resetIdCounter();
    const req = createRequest("c", {});
    expect(req.id).toBe(1);
  });
});

// ============================================================================
// createSuccessResponse
// ============================================================================

describe("createSuccessResponse", () => {
  it("returns a message with jsonrpc='2.0'", () => {
    const res = createSuccessResponse(1, "ok");
    expect(res.jsonrpc).toBe("2.0");
  });

  it("echoes the request id", () => {
    const res = createSuccessResponse(42, "done");
    expect(res.id).toBe(42);
  });

  it("includes the result", () => {
    const result = { status: "ok", count: 7 };
    const res = createSuccessResponse(1, result);
    expect(res.result).toEqual(result);
  });

  it("accepts string id", () => {
    const res = createSuccessResponse("req-abc", { data: true });
    expect(res.id).toBe("req-abc");
  });

  it("result can be null", () => {
    const res = createSuccessResponse(1, null);
    expect(res.result).toBeNull();
  });

  it("result can be a boolean", () => {
    const res = createSuccessResponse(1, false);
    expect(res.result).toBe(false);
  });
});

// ============================================================================
// createErrorResponse
// ============================================================================

describe("createErrorResponse", () => {
  it("returns a message with jsonrpc='2.0'", () => {
    const res = createErrorResponse(1, -32600, "Invalid request");
    expect(res.jsonrpc).toBe("2.0");
  });

  it("echoes the request id", () => {
    const res = createErrorResponse(7, -32600, "err");
    expect(res.id).toBe(7);
  });

  it("sets error.code and error.message", () => {
    const res = createErrorResponse(1, -32700, "Parse error");
    expect(res.error.code).toBe(-32700);
    expect(res.error.message).toBe("Parse error");
  });

  it("accepts null id (for parse errors where id could not be determined)", () => {
    const res = createErrorResponse(null, -32700, "Parse error");
    expect(res.id).toBeNull();
  });

  it("omits error.data when no data argument provided", () => {
    const res = createErrorResponse(1, -32600, "err");
    expect(res.error).not.toHaveProperty("data");
  });

  it("includes error.data when provided", () => {
    const data = { detail: "missing field" };
    const res = createErrorResponse(1, -32602, "Invalid params", data);
    expect(res.error.data).toEqual(data);
  });

  it("accepts string id", () => {
    const res = createErrorResponse("req-1", -32600, "err");
    expect(res.id).toBe("req-1");
  });
});

// ============================================================================
// createNotification
// ============================================================================

describe("createNotification", () => {
  it("returns a message with jsonrpc='2.0'", () => {
    const notif = createNotification("worker.event", {});
    expect(notif.jsonrpc).toBe("2.0");
  });

  it("includes the method name", () => {
    const notif = createNotification("host.status_update", { ready: true });
    expect(notif.method).toBe("host.status_update");
  });

  it("includes the params", () => {
    const params = { event: "progress", value: 50 };
    const notif = createNotification("worker.progress", params);
    expect(notif.params).toEqual(params);
  });

  it("does not include an id field", () => {
    const notif = createNotification("worker.event", {});
    expect(notif).not.toHaveProperty("id");
  });
});

// ============================================================================
// isJsonRpcRequest
// ============================================================================

describe("isJsonRpcRequest", () => {
  it("returns true for a well-formed request", () => {
    const req = createRequest("ping", {});
    expect(isJsonRpcRequest(req)).toBe(true);
  });

  it("returns true for a manually constructed request with numeric id", () => {
    expect(isJsonRpcRequest({ jsonrpc: "2.0", id: 1, method: "test", params: {} })).toBe(true);
  });

  it("returns true for a request with string id", () => {
    expect(isJsonRpcRequest({ jsonrpc: "2.0", id: "abc", method: "test", params: {} })).toBe(true);
  });

  it("returns false for a notification (no id)", () => {
    const notif = createNotification("ping", {});
    expect(isJsonRpcRequest(notif)).toBe(false);
  });

  it("returns false for a response", () => {
    const res = createSuccessResponse(1, "ok");
    expect(isJsonRpcRequest(res)).toBe(false);
  });

  it("returns false for null", () => {
    expect(isJsonRpcRequest(null)).toBe(false);
  });

  it("returns false for a string", () => {
    expect(isJsonRpcRequest("not an object")).toBe(false);
  });

  it("returns false when jsonrpc version is wrong", () => {
    expect(isJsonRpcRequest({ jsonrpc: "1.0", id: 1, method: "test" })).toBe(false);
  });

  it("returns false when method is missing", () => {
    expect(isJsonRpcRequest({ jsonrpc: "2.0", id: 1, params: {} })).toBe(false);
  });

  it("returns false when id is undefined", () => {
    expect(isJsonRpcRequest({ jsonrpc: "2.0", method: "test", id: undefined })).toBe(false);
  });
});

// ============================================================================
// isJsonRpcNotification
// ============================================================================

describe("isJsonRpcNotification", () => {
  it("returns true for a well-formed notification", () => {
    const notif = createNotification("ping", {});
    expect(isJsonRpcNotification(notif)).toBe(true);
  });

  it("returns false for a request (has id)", () => {
    const req = createRequest("ping", {});
    expect(isJsonRpcNotification(req)).toBe(false);
  });

  it("returns false for a response", () => {
    const res = createSuccessResponse(1, "ok");
    expect(isJsonRpcNotification(res)).toBe(false);
  });

  it("returns false for null", () => {
    expect(isJsonRpcNotification(null)).toBe(false);
  });

  it("returns false when jsonrpc version is wrong", () => {
    expect(isJsonRpcNotification({ jsonrpc: "1.0", method: "test" })).toBe(false);
  });
});

// ============================================================================
// isJsonRpcResponse
// ============================================================================

describe("isJsonRpcResponse", () => {
  it("returns true for a success response", () => {
    const res = createSuccessResponse(1, "ok");
    expect(isJsonRpcResponse(res)).toBe(true);
  });

  it("returns true for an error response", () => {
    const res = createErrorResponse(1, -32600, "err");
    expect(isJsonRpcResponse(res)).toBe(true);
  });

  it("returns false for a request", () => {
    const req = createRequest("ping", {});
    expect(isJsonRpcResponse(req)).toBe(false);
  });

  it("returns false for a notification", () => {
    const notif = createNotification("ping", {});
    expect(isJsonRpcResponse(notif)).toBe(false);
  });

  it("returns false for null", () => {
    expect(isJsonRpcResponse(null)).toBe(false);
  });
});

// ============================================================================
// isJsonRpcSuccessResponse
// ============================================================================

describe("isJsonRpcSuccessResponse", () => {
  it("returns true for a success response", () => {
    const res = createSuccessResponse(1, "done");
    expect(isJsonRpcSuccessResponse(res)).toBe(true);
  });

  it("returns false for an error response", () => {
    const err = createErrorResponse(1, -32600, "bad");
    // isJsonRpcSuccessResponse takes JsonRpcResponse, error response is a valid response
    expect(isJsonRpcSuccessResponse(err as Parameters<typeof isJsonRpcSuccessResponse>[0])).toBe(false);
  });
});

// ============================================================================
// isJsonRpcErrorResponse
// ============================================================================

describe("isJsonRpcErrorResponse", () => {
  it("returns true for an error response", () => {
    const err = createErrorResponse(1, -32600, "bad");
    // cast as JsonRpcResponse for the type guard
    expect(isJsonRpcErrorResponse(err as Parameters<typeof isJsonRpcErrorResponse>[0])).toBe(true);
  });

  it("returns false for a success response", () => {
    const res = createSuccessResponse(1, "ok");
    expect(isJsonRpcErrorResponse(res)).toBe(false);
  });
});

// ============================================================================
// serializeMessage
// ============================================================================

describe("serializeMessage", () => {
  it("returns valid JSON terminated by a newline", () => {
    const req = createRequest("ping", {});
    const serialized = serializeMessage(req);
    expect(serialized.endsWith("\n")).toBe(true);
    // The part before the newline is valid JSON
    expect(() => JSON.parse(serialized.trimEnd())).not.toThrow();
  });

  it("serialized JSON round-trips back to the original message", () => {
    const req = createRequest("test.method", { a: 1, b: "two" });
    const serialized = serializeMessage(req);
    const parsed = JSON.parse(serialized.trimEnd());
    expect(parsed).toEqual(req);
  });

  it("works for success responses", () => {
    const res = createSuccessResponse(5, { status: "done" });
    const serialized = serializeMessage(res);
    expect(serialized).toContain('"result"');
  });

  it("works for error responses", () => {
    const err = createErrorResponse(2, -32600, "oops");
    const serialized = serializeMessage(err);
    expect(serialized).toContain('"error"');
  });

  it("works for notifications", () => {
    const notif = createNotification("worker.event", { x: true });
    const serialized = serializeMessage(notif);
    expect(serialized).toContain('"method"');
    expect(serialized).not.toContain('"id"');
  });
});

// ============================================================================
// parseMessage
// ============================================================================

describe("parseMessage", () => {
  it("parses a valid request line", () => {
    const req = createRequest("ping", { ts: 1 });
    const line = JSON.stringify(req);
    const parsed = parseMessage(line);
    expect(parsed).toEqual(req);
  });

  it("parses a line produced by serializeMessage (with trailing newline)", () => {
    const req = createRequest("ping", {});
    const line = serializeMessage(req); // includes trailing \n
    const parsed = parseMessage(line);
    expect(parsed).toEqual(req);
  });

  it("parses a valid notification", () => {
    const notif = createNotification("worker.status", { ready: true });
    const parsed = parseMessage(JSON.stringify(notif));
    expect(parsed).toEqual(notif);
  });

  it("parses a success response", () => {
    const res = createSuccessResponse(3, "result-value");
    const parsed = parseMessage(JSON.stringify(res));
    expect(parsed).toEqual(res);
  });

  it("parses an error response", () => {
    const err = createErrorResponse(4, -32600, "invalid");
    const parsed = parseMessage(JSON.stringify(err));
    expect(parsed).toEqual(err);
  });

  it("throws JsonRpcParseError for an empty string", () => {
    expect(() => parseMessage("")).toThrow(JsonRpcParseError);
  });

  it("throws JsonRpcParseError for a whitespace-only string", () => {
    expect(() => parseMessage("   ")).toThrow(JsonRpcParseError);
  });

  it("throws JsonRpcParseError for invalid JSON", () => {
    expect(() => parseMessage("{not valid json")).toThrow(JsonRpcParseError);
  });

  it("throws JsonRpcParseError for a non-object JSON value (array)", () => {
    expect(() => parseMessage("[1,2,3]")).toThrow(JsonRpcParseError);
  });

  it("throws JsonRpcParseError for a JSON string primitive", () => {
    expect(() => parseMessage('"just a string"')).toThrow(JsonRpcParseError);
  });

  it("throws JsonRpcParseError when jsonrpc version is missing", () => {
    expect(() => parseMessage(JSON.stringify({ id: 1, method: "test", params: {} }))).toThrow(JsonRpcParseError);
  });

  it("throws JsonRpcParseError when jsonrpc version is wrong", () => {
    expect(() => parseMessage(JSON.stringify({ jsonrpc: "1.0", id: 1, method: "test" }))).toThrow(JsonRpcParseError);
  });
});

// ============================================================================
// JsonRpcParseError
// ============================================================================

describe("JsonRpcParseError", () => {
  it("has name='JsonRpcParseError'", () => {
    const err = new JsonRpcParseError("bad");
    expect(err.name).toBe("JsonRpcParseError");
  });

  it("inherits from Error", () => {
    const err = new JsonRpcParseError("test");
    expect(err).toBeInstanceOf(Error);
  });

  it("stores the message", () => {
    const err = new JsonRpcParseError("something went wrong");
    expect(err.message).toBe("something went wrong");
  });
});

// ============================================================================
// JsonRpcCallError
// ============================================================================

describe("JsonRpcCallError", () => {
  it("has name='JsonRpcCallError'", () => {
    const err = new JsonRpcCallError({ code: -32600, message: "Invalid request" });
    expect(err.name).toBe("JsonRpcCallError");
  });

  it("inherits from Error", () => {
    const err = new JsonRpcCallError({ code: -32600, message: "err" });
    expect(err).toBeInstanceOf(Error);
  });

  it("stores the error code", () => {
    const err = new JsonRpcCallError({ code: -32601, message: "Method not found" });
    expect(err.code).toBe(-32601);
  });

  it("stores the error message", () => {
    const err = new JsonRpcCallError({ code: -32600, message: "Custom error message" });
    expect(err.message).toBe("Custom error message");
  });

  it("stores the error data when present", () => {
    const data = { field: "foo", expected: "string" };
    const err = new JsonRpcCallError({ code: -32602, message: "Invalid params", data });
    expect(err.data).toEqual(data);
  });

  it("data is undefined when not provided", () => {
    const err = new JsonRpcCallError({ code: -32600, message: "err" });
    expect(err.data).toBeUndefined();
  });
});
