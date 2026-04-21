import { AdapterEnvironmentTestContext, AdapterEnvironmentTestResult, AdapterEnvironmentCheck } from "@paperclipai/adapter-utils";

export async function testLlamaEnvironment(ctx: AdapterEnvironmentTestContext): Promise<AdapterEnvironmentTestResult> {
  const llamacppUrl = asString(ctx.config.llamacppUrl, "http://localhost:8000");

  const checks: AdapterEnvironmentCheck[] = [];

  // Check 1: llama.cpp server is reachable
  try {
    const response = await fetch(`${llamacppUrl}/v1/models`);
    if (response.ok) {
      const data = await response.json();
      checks.push({
        code: "server_reachable",
        level: "info",
        message: `Server responding. Loaded model: ${data.data?.[0]?.id ?? "unknown"}`,
      });
    } else {
      checks.push({
        code: "server_reachable",
        level: "error",
        message: `Server returned ${response.status}`,
      });
    }
  } catch (err) {
    checks.push({
      code: "server_reachable",
      level: "error",
      message: `Cannot connect to ${llamacppUrl}. Is llama.cpp running?`,
    });
  }

  // Check 2: Model is loaded
  try {
    const response = await fetch(`${llamacppUrl}/v1/models`);
    const data = await response.json();
    const modelLoaded = data.data?.some((m: any) => m.id === ctx.config.model);
    checks.push({
      code: "model_loaded",
      level: modelLoaded ? "info" : "error",
      message: modelLoaded
        ? `Model ${ctx.config.model} is loaded`
        : `Model ${ctx.config.model} not found. Available: ${data.data?.map((m: any) => m.id).join(", ")}`,
    });
  } catch (err) {
    checks.push({
      code: "model_loaded",
      level: "error",
      message: `Could not check loaded models`,
    });
  }

  // Check 3: Quick inference test
  try {
    const response = await fetch(`${llamacppUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: ctx.config.model,
        messages: [{ role: "user", content: "Hello. Respond in one word." }],
        max_tokens: 10,
      }),
    });

    if (response.ok) {
      checks.push({
        code: "inference_test",
        level: "info",
        message: "Model responds to queries",
      });
    } else {
      checks.push({
        code: "inference_test",
        level: "error",
        message: `Inference failed: ${response.status}`,
      });
    }
  } catch (err) {
    checks.push({
      code: "inference_test",
      level: "error",
      message: `Could not test inference: ${err}`,
    });
  }

  return {
    adapterType: "llamacpp_local",
    status: checks.every(c => c.level !== "error") ? "pass" : "fail",
    checks,
    testedAt: new Date().toISOString(),
  };
}

function asString(value: unknown, defaultValue: string): string {
  return typeof value === 'string' ? value : defaultValue;
}