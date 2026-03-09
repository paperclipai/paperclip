import { describe, expect, it, vi } from "vitest";
import worker from "../../../packages/plugins/examples/plugin-tools-example/src/worker.js";

describe("tools example worker", () => {
  it("logs setup starting", async () => {
    const info = vi.fn();
    const register = vi.fn();
    const ctx = {
      logger: {
        info,
      },
      tools: {
        register,
      },
    };

    await worker.definition.setup(ctx as any);

    expect(info).toHaveBeenCalledWith("Tools example plugin starting");
    expect(register).toHaveBeenCalledWith("calculator", expect.any(Object), expect.any(Function));
    expect(register).toHaveBeenCalledWith("weather-lookup", expect.any(Object), expect.any(Function));
  });

  it("returns an ok health payload", async () => {
    const result = await worker.definition.onHealth?.();

    expect(result).toEqual({
      status: "ok",
      message: "Tools example plugin healthy",
    });
  });

  describe("calculator tool", () => {
    const setupTool = async () => {
      const register = vi.fn();
      const log = vi.fn();
      const info = vi.fn();
      const ctx = {
        logger: { info },
        tools: { register },
        activity: { log },
      };

      await worker.definition.setup(ctx as any);
      
      // Find the calculator registration
      const call = register.mock.calls.find(c => c[0] === "calculator");
      if (!call) throw new Error("Calculator tool not registered");
      
      const handler = call[2];
      return { handler, log, info };
    };

    it("adds two numbers", async () => {
      const { handler, log } = await setupTool();
      const runCtx = { agentId: "a1", runId: "r1", companyId: "c1", projectId: "p1" };
      
      const result = await handler({ a: 5, b: 3, operation: "add" }, runCtx);
      
      expect(result).toEqual({
        content: "The result of 5 add 3 is 8.",
        data: { result: 8, operation: "add", operands: [5, 3] }
      });
      
      expect(log).toHaveBeenCalledWith(expect.objectContaining({
        message: "Agent used calculator: 5 add 3 = 8"
      }));
    });

    it("subtracts two numbers", async () => {
      const { handler } = await setupTool();
      const runCtx = { agentId: "a1", runId: "r1", companyId: "c1", projectId: "p1" };
      
      const result = await handler({ a: 10, b: 4, operation: "subtract" }, runCtx);
      expect(result.data.result).toBe(6);
    });

    it("multiplies two numbers", async () => {
      const { handler } = await setupTool();
      const runCtx = { agentId: "a1", runId: "r1", companyId: "c1", projectId: "p1" };
      
      const result = await handler({ a: 6, b: 7, operation: "multiply" }, runCtx);
      expect(result.data.result).toBe(42);
    });

    it("divides two numbers", async () => {
      const { handler } = await setupTool();
      const runCtx = { agentId: "a1", runId: "r1", companyId: "c1", projectId: "p1" };
      
      const result = await handler({ a: 20, b: 5, operation: "divide" }, runCtx);
      expect(result.data.result).toBe(4);
    });

    it("returns error on division by zero", async () => {
      const { handler } = await setupTool();
      const runCtx = { agentId: "a1", runId: "r1", companyId: "c1", projectId: "p1" };
      
      const result = await handler({ a: 20, b: 0, operation: "divide" }, runCtx);
      expect(result).toEqual({ error: "Division by zero is not allowed." });
    });

    it("returns error on unsupported operation", async () => {
      const { handler } = await setupTool();
      const runCtx = { agentId: "a1", runId: "r1", companyId: "c1", projectId: "p1" };
      
      const result = await handler({ a: 20, b: 5, operation: "modulo" }, runCtx);
      expect(result).toEqual({ error: "Unsupported operation: modulo" });
    });
  });

  describe("weather-lookup tool", () => {
    const setupTool = async () => {
      const register = vi.fn();
      const log = vi.fn();
      const info = vi.fn();
      const ctx = {
        logger: { info },
        tools: { register },
        activity: { log },
      };

      await worker.definition.setup(ctx as any);
      
      const call = register.mock.calls.find(c => c[0] === "weather-lookup");
      if (!call) throw new Error("Weather lookup tool not registered");
      
      const handler = call[2];
      return { handler, log };
    };

    it("returns weather for a known city", async () => {
      const { handler, log } = await setupTool();
      const runCtx = { agentId: "a1", runId: "r1", companyId: "c1", projectId: "p1" };
      
      const result = await handler({ city: "London" }, runCtx);
      
      expect(result.content).toContain("London");
      expect(result.data).toEqual({
        city: "London",
        temp: 15,
        condition: "Cloudy"
      });
      
      expect(log).toHaveBeenCalledWith(expect.objectContaining({
        message: "Agent looked up weather for London"
      }));
    });

    it("returns random weather for an unknown city", async () => {
      const { handler } = await setupTool();
      const runCtx = { agentId: "a1", runId: "r1", companyId: "c1", projectId: "p1" };
      
      const result = await handler({ city: "Atlantis" }, runCtx);
      
      expect(result.content).toContain("Atlantis");
      expect(result.data.city).toBe("Atlantis");
      expect(result.data.temp).toBeDefined();
      expect(result.data.condition).toBe("Variable");
    });
  });
});
