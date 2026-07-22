const DEFAULT_CAPTURED_OUTPUT_BYTES = 256 * 1024;
const DEFAULT_JSON_RESPONSE_BYTES = 64 * 1024;

function normalizeByteLimit(maxBytes) {
  return Math.max(1, Math.trunc(maxBytes));
}

export function createCapturedOutputBuffer(maxBytes = DEFAULT_CAPTURED_OUTPUT_BYTES) {
  const limit = normalizeByteLimit(maxBytes);
  const chunks = [];
  let bufferedBytes = 0;
  let totalBytes = 0;
  let truncated = false;

  return {
    append(chunk) {
      if (chunk === null || chunk === undefined) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (buffer.length === 0) return;

      chunks.push(buffer);
      bufferedBytes += buffer.length;
      totalBytes += buffer.length;

      while (bufferedBytes > limit && chunks.length > 0) {
        const overflow = bufferedBytes - limit;
        const head = chunks[0];
        if (head.length <= overflow) {
          chunks.shift();
          bufferedBytes -= head.length;
          truncated = true;
          continue;
        }

        chunks[0] = head.subarray(overflow);
        bufferedBytes -= overflow;
        truncated = true;
      }
    },

    finish() {
      const body = Buffer.concat(chunks).toString("utf8");
      if (!truncated) {
        return {
          text: body,
          truncated,
          totalBytes,
        };
      }

      return {
        text: `[output truncated to last ${limit} bytes; total ${totalBytes} bytes]\n${body}`,
        truncated,
        totalBytes,
      };
    },
  };
}

export async function parseJsonResponseWithLimit(response, maxBytes = DEFAULT_JSON_RESPONSE_BYTES) {
  const limit = normalizeByteLimit(maxBytes);
  const contentLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(contentLength) && contentLength > limit) {
    throw new Error(`Response exceeds ${limit} bytes`);
  }

  if (!response.body) {
    return JSON.parse("");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > limit) {
        await reader.cancel("response too large");
        throw new Error(`Response exceeds ${limit} bytes`);
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }

  return JSON.parse(text);
}
