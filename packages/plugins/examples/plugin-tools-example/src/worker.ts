import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import type { ToolRunContext, ToolResult } from "@paperclipai/plugin-sdk";

const PLUGIN_NAME = "Tools example";
const HEALTH_MESSAGE = "Tools example plugin healthy";

/** Calculator params from the manifest schema */
interface CalculatorParams {
  a: number;
  b: number;
  operation: "add" | "subtract" | "multiply" | "divide";
}

/** Weather lookup params */
interface WeatherParams {
  city: string;
}

/** Known cities with fixed mock weather for demo consistency */
const KNOWN_WEATHER: Record<string, { temp: number; condition: string }> = {
  London: { temp: 15, condition: "Cloudy" },
  Tokyo: { temp: 22, condition: "Sunny" },
  "New York": { temp: 18, condition: "Partly cloudy" },
};

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info(`${PLUGIN_NAME} plugin starting`);

    const calculatorDeclaration = {
      name: "calculator",
      displayName: "Calculator",
      description:
        "Performs basic arithmetic: add, subtract, multiply, or divide two numbers.",
      parametersSchema: {
        type: "object",
        required: ["a", "b", "operation"],
        properties: {
          a: { type: "number", description: "First operand" },
          b: { type: "number", description: "Second operand" },
          operation: {
            type: "string",
            enum: ["add", "subtract", "multiply", "divide"],
            description: "The arithmetic operation to perform",
          },
        },
      },
    };

    ctx.tools.register(
      "calculator",
      calculatorDeclaration,
      async (params: unknown, runCtx: ToolRunContext): Promise<ToolResult> => {
        const { a, b, operation } = params as CalculatorParams;
        const ops = ["add", "subtract", "multiply", "divide"] as const;
        if (!ops.includes(operation)) {
          return { error: `Unsupported operation: ${operation}` };
        }
        let result: number;
        switch (operation) {
          case "add":
            result = a + b;
            break;
          case "subtract":
            result = a - b;
            break;
          case "multiply":
            result = a * b;
            break;
          case "divide":
            if (b === 0) return { error: "Division by zero is not allowed." };
            result = a / b;
            break;
        }
        await ctx.activity.log({
          companyId: runCtx.companyId,
          message: `Agent used calculator: ${a} ${operation} ${b} = ${result}`,
          entityType: "agent",
          entityId: runCtx.agentId,
        });
        return {
          content: `The result of ${a} ${operation} ${b} is ${result}.`,
          data: { result, operation, operands: [a, b] },
        };
      },
    );

    const weatherDeclaration = {
      name: "weather-lookup",
      displayName: "Weather Lookup",
      description: "Looks up current weather for a city (mock data).",
      parametersSchema: {
        type: "object",
        required: ["city"],
        properties: {
          city: { type: "string", description: "City name to look up" },
        },
      },
    };

    ctx.tools.register(
      "weather-lookup",
      weatherDeclaration,
      async (params: unknown, runCtx: ToolRunContext): Promise<ToolResult> => {
        const { city } = params as WeatherParams;
        const known = KNOWN_WEATHER[city];
        const data = known
          ? { city, temp: known.temp, condition: known.condition }
          : {
              city,
              temp: Math.floor(Math.random() * 30) + 5,
              condition: "Variable",
            };
        await ctx.activity.log({
          companyId: runCtx.companyId,
          message: `Agent looked up weather for ${city}`,
          entityType: "agent",
          entityId: runCtx.agentId,
        });
        return {
          content: `Weather in ${city}: ${data.temp}°C, ${data.condition}.`,
          data,
        };
      },
    );
  },

  async onHealth() {
    return { status: "ok", message: HEALTH_MESSAGE };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
