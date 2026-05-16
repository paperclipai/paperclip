import process from "node:process";

type Mode = "responses" | "chat_completions";

function readArg(name: string, fallback = ""): string {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  return process.argv[index + 1] ?? fallback;
}

function createUrl(baseUrl: string, path: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  if (trimmed.endsWith("/v1") && path.startsWith("/v1/")) {
    return `${trimmed}${path.slice(3)}`;
  }
  return `${trimmed}${path}`;
}

async function consumeSse(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });

    let splitIndex = buffer.indexOf("\n\n");
    while (splitIndex >= 0) {
      const block = buffer.slice(0, splitIndex).replace(/\r$/, "");
      buffer = buffer.slice(splitIndex + 2);
      const lines = block.split(/\r?\n/);
      let eventName = "message";
      const dataLines: string[] = [];
      for (const line of lines) {
        if (!line || line.startsWith(":")) continue;
        if (line.startsWith("event:")) {
          eventName = line.slice("event:".length).trim() || "message";
          continue;
        }
        if (line.startsWith("data:")) {
          dataLines.push(line.slice("data:".length).trimStart());
        }
      }
      if (dataLines.length > 0) {
        console.log(`\n[event] ${eventName}`);
        console.log(dataLines.join("\n"));
      }
      splitIndex = buffer.indexOf("\n\n");
    }

    if (done) break;
  }
}

async function main() {
  const baseUrl = readArg("base-url", "http://127.0.0.1:8000");
  const mode = (readArg("mode", "responses") || "responses") as Mode;
  const model = readArg("model", "hermes-agent");
  const input = readArg("input", "Summarize the current workspace status.");
  const instructions = readArg("instructions", "You are a Paperclip-managed Hermes test harness run.");
  const conversation = readArg("conversation", "paperclip-harness");

  const url =
    mode === "chat_completions"
      ? createUrl(baseUrl, "/v1/chat/completions")
      : createUrl(baseUrl, "/v1/responses");

  const body =
    mode === "chat_completions"
      ? {
          model,
          stream: true,
          messages: [
            { role: "system", content: instructions },
            { role: "user", content: input },
          ],
        }
      : {
          model,
          stream: true,
          conversation,
          instructions,
          input,
        };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "text/event-stream",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok || !response.body) {
    const errorBody = await response.text();
    throw new Error(`Request failed: ${response.status} ${response.statusText}\n${errorBody}`);
  }

  console.log(`[harness] connected to ${url}`);
  console.log(`[harness] sessionId=${response.headers.get("X-Hermes-Session-Id") ?? "none"}`);
  console.log(`[harness] sessionKey=${response.headers.get("X-Hermes-Session-Key") ?? "none"}`);
  await consumeSse(response.body);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
