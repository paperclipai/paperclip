import pc from "picocolors";

export function printGeminiStreamEvent(raw: string, debug: boolean): void {
  const line = raw.trim();
  if (!line) return;

  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(line) as Record<string, unknown>;
  } catch {
    console.log(line);
    return;
  }

  const type = typeof parsed.type === "string" ? parsed.type : "";

  if (type === "init") {
    const model = typeof parsed.model === "string" ? parsed.model : "unknown";
    const sessionId = typeof parsed.session_id === "string" ? parsed.session_id : "";
    console.log(pc.blue(`Gemini initialized (model: ${model}${sessionId ? `, session: ${sessionId}` : ""})`));
    return;
  }

  if (type === "message") {
    const role = typeof parsed.role === "string" ? parsed.role : "";
    const content = typeof parsed.content === "string" ? parsed.content : "";
    if (role === "assistant" && content) {
      console.log(pc.green(`assistant: ${content}`));
    } else if (role === "user" && content) {
      if (debug) console.log(pc.gray(`user: ${content}`));
    }
    return;
  }

  if (type === "tool_use") {
    const name = typeof parsed.tool_name === "string" ? parsed.tool_name : "unknown";
    console.log(pc.yellow(`tool_call: ${name}`));
    if (parsed.parameters !== undefined) {
      console.log(pc.gray(JSON.stringify(parsed.parameters, null, 2)));
    }
    return;
  }

  if (type === "tool_result") {
    const toolId = typeof parsed.tool_id === "string" ? parsed.tool_id : "";
    const status = typeof parsed.status === "string" ? parsed.status : "";
    const output = typeof parsed.output === "string" ? parsed.output : "";
    if (status === "error") {
      console.log(pc.red(`tool_result [${toolId}]: ${output}`));
    } else if (debug && output) {
      console.log(pc.gray(`tool_result [${toolId}]: ${output.slice(0, 200)}`));
    }
    return;
  }

  if (type === "result") {
    const stats =
      typeof parsed.stats === "object" && parsed.stats !== null && !Array.isArray(parsed.stats)
        ? (parsed.stats as Record<string, unknown>)
        : {};
    const input = Number(stats.input_tokens ?? 0);
    const output = Number(stats.output_tokens ?? 0);
    const totalTokens = Number(stats.total_tokens ?? 0);
    const cost = Number(parsed.cost_usd ?? 0);
    const status = typeof parsed.status === "string" ? parsed.status : "";
    const isError = status === "error";
    const resultText = typeof parsed.result === "string" ? parsed.result : "";
    if (resultText) {
      console.log(pc.green("result:"));
      console.log(resultText);
    }
    const errorMsg = typeof parsed.error === "string" ? parsed.error : "";
    if (isError || errorMsg) {
      console.log(pc.red(`gemini_result: status=${status || "unknown"}`));
      if (errorMsg) console.log(pc.red(`gemini_error: ${errorMsg}`));
    }
    console.log(
      pc.blue(
        `tokens: in=${Number.isFinite(input) ? input : 0} out=${Number.isFinite(output) ? output : 0} total=${Number.isFinite(totalTokens) ? totalTokens : 0} cost=$${Number.isFinite(cost) ? cost.toFixed(6) : "0.000000"}`,
      ),
    );
    return;
  }

  if (type === "error") {
    const errorMsg = typeof parsed.message === "string" ? parsed.message : (typeof parsed.error === "string" ? parsed.error : line);
    console.log(pc.red(`gemini_error: ${errorMsg}`));
    return;
  }

  if (debug) {
    console.log(pc.gray(line));
  }
}
