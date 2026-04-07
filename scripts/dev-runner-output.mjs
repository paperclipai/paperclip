const DEFAULT_CAPTURED_OUTPUT_BYTES = 256 * 1024;

export function createCapturedOutputBuffer(maxBytes = DEFAULT_CAPTURED_OUTPUT_BYTES) {
  const limit = Math.max(1, Math.trunc(maxBytes));
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
