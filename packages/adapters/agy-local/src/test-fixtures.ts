// One stream-json format for the server parser, the UI transcript parser and the
// CLI formatter. agy names each event with the `event` field.
export const AGY_CONVERSATION_ID = "709d5579-1f73-490d-a519-43174cf043a5";

const line = (value: unknown) => JSON.stringify(value);

export const AGY_INIT_LINE = line({
  event: "init",
  conversation_id: AGY_CONVERSATION_ID,
  init: { model: "gemini-3.8-flash-low" },
});

export const AGY_TOOL_DONE_LINE = line({
  event: "step_update",
  step_update: {
    conversation_id: AGY_CONVERSATION_ID,
    step_index: 2,
    state: "DONE",
    step_type: "tool",
    tool_info: { name: "ls", parameters: { p: 1 }, output: "ok" },
  },
});

export const AGY_RESULT_LINE = line({
  event: "result",
  result: {
    conversation_id: AGY_CONVERSATION_ID,
    status: "SUCCESS",
    response: "hi",
    usage: { input_tokens: 3, output_tokens: 2, thinking_tokens: 1, cache_read_tokens: 4 },
  },
});
