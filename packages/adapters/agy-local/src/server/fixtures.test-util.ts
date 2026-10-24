/**
 * Fixtures captured verbatim from `agy --output-format stream-json`.
 */

export const SIMPLE_RUN = [
  '{"event":"init","conversation_id":"1d4068bc-62e4-47ec-ad8b-6e83372b5f32","init":{"cwd":"/tmp/agyprobe","tools":["view_file","write_to_file","run_command"],"permission_mode":"always-proceed"}}',
  '{"event":"step_update","step_update":{"conversation_id":"1d4068bc-62e4-47ec-ad8b-6e83372b5f32","step_index":0,"state":"DONE","step_type":"user_input"}}',
  '{"event":"step_update","step_update":{"conversation_id":"1d4068bc-62e4-47ec-ad8b-6e83372b5f32","step_index":1,"state":"ACTIVE","step_type":"agent_response","text_delta":"HELLO_AGY"}}',
  '{"event":"step_update","step_update":{"conversation_id":"1d4068bc-62e4-47ec-ad8b-6e83372b5f32","step_index":1,"state":"DONE","step_type":"agent_response","text_delta":"\\n","duration_seconds":2.150675,"usage":{"input_tokens":5286,"output_tokens":90,"thinking_tokens":86,"cache_read_tokens":8128,"total_tokens":5376}}}',
  '{"event":"result","result":{"conversation_id":"1d4068bc-62e4-47ec-ad8b-6e83372b5f32","status":"SUCCESS","response":"HELLO_AGY\\n","duration_seconds":2.200071,"num_turns":1,"usage":{"input_tokens":5286,"output_tokens":90,"thinking_tokens":86,"cache_read_tokens":8128,"total_tokens":5376}}}',
].join("\n");

export const TOOL_RUN = [
  '{"event":"init","conversation_id":"7d7f147a-a3fe-46d1-885e-067ee3ee1ea0","init":{"cwd":"/tmp/agyprobe","tools":["view_file","write_to_file"],"permission_mode":"always-proceed"}}',
  '{"event":"step_update","step_update":{"conversation_id":"7d7f147a-a3fe-46d1-885e-067ee3ee1ea0","step_index":0,"state":"DONE","step_type":"user_input"}}',
  '{"event":"step_update","step_update":{"conversation_id":"7d7f147a-a3fe-46d1-885e-067ee3ee1ea0","step_index":1,"state":"DONE","step_type":"agent_response","duration_seconds":3.248163,"usage":{"input_tokens":5298,"output_tokens":923,"thinking_tokens":841,"cache_read_tokens":8129,"total_tokens":6221}}}',
  '{"event":"step_update","step_update":{"conversation_id":"7d7f147a-a3fe-46d1-885e-067ee3ee1ea0","step_index":2,"state":"ACTIVE","step_type":"tool","tool_name":"write_to_file","tool_info":{"name":"write_to_file","parameters":{"TargetFile":"/tmp/agyprobe/probe.txt"}}}}',
  '{"event":"step_update","step_update":{"conversation_id":"7d7f147a-a3fe-46d1-885e-067ee3ee1ea0","step_index":2,"state":"DONE","step_type":"tool","tool_name":"write_to_file","duration_seconds":0.01667,"tool_info":{"name":"write_to_file","parameters":{"TargetFile":"/tmp/agyprobe/probe.txt"}}}}',
  '{"event":"step_update","step_update":{"conversation_id":"7d7f147a-a3fe-46d1-885e-067ee3ee1ea0","step_index":4,"state":"ACTIVE","step_type":"tool","tool_name":"view_file","tool_info":{"name":"view_file","parameters":{"AbsolutePath":"/tmp/agyprobe/probe.txt"}}}}',
  '{"event":"step_update","step_update":{"conversation_id":"7d7f147a-a3fe-46d1-885e-067ee3ee1ea0","step_index":4,"state":"DONE","step_type":"tool","tool_name":"view_file","duration_seconds":0.810565,"tool_info":{"name":"view_file","parameters":{"AbsolutePath":"/tmp/agyprobe/probe.txt"},"output":"2 lines, 7 bytes"}}}',
  '{"event":"step_update","step_update":{"conversation_id":"7d7f147a-a3fe-46d1-885e-067ee3ee1ea0","step_index":5,"state":"ACTIVE","step_type":"agent_response","text_delta":"I have created probe.tx"}}',
  '{"event":"step_update","step_update":{"conversation_id":"7d7f147a-a3fe-46d1-885e-067ee3ee1ea0","step_index":5,"state":"DONE","step_type":"agent_response","text_delta":"t and read it back.","duration_seconds":2.453059,"usage":{"input_tokens":6613,"output_tokens":124,"thinking_tokens":75,"cache_read_tokens":8123,"total_tokens":6737}}}',
  '{"event":"result","result":{"conversation_id":"7d7f147a-a3fe-46d1-885e-067ee3ee1ea0","status":"SUCCESS","response":"I have created probe.txt and read it back.","duration_seconds":7.606609,"num_turns":1,"usage":{"input_tokens":18259,"output_tokens":1111,"thinking_tokens":927,"cache_read_tokens":24379,"total_tokens":19370}}}',
].join("\n");

export const TRUNCATED_RUN = [
  '{"event":"init","conversation_id":"abc-123","init":{"cwd":"/tmp/agyprobe","tools":[],"permission_mode":"always-proceed"}}',
  '{"event":"step_update","step_update":{"conversation_id":"abc-123","step_index":1,"state":"ACTIVE","step_type":"agent_response","text_delta":"working on it","usage":{"input_tokens":10,"output_tokens":5,"thinking_tokens":1,"cache_read_tokens":2,"total_tokens":15}}}',
].join("\n");

export const MODELS_OUTPUT = [
  "Fetching available models...",
  "gemini-3.8-flash-high\tGemini 3.8 Flash (High)",
  "gemini-3.1-pro-high\tGemini 3.1 Pro (High)",
  "claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)",
  "gpt-oss-120b-medium\tGPT-OSS 120B (Medium)",
].join("\n");

/**
 * A recoverable tool error mid-run; the agent recovers and agy reports SUCCESS.
 */
export const TOOL_ERROR_RECOVERED_RUN = [
  '{"event":"init","conversation_id":"abad2b3a-2b63-46bb-a909-1bebf703383a","init":{"model":"gemini-3.8-flash-low","cwd":"/tmp/agyprobe","tools":["view_file","write_to_file","run_command"],"permission_mode":"request-review"}}',
  '{"event":"step_update","step_update":{"conversation_id":"abad2b3a-2b63-46bb-a909-1bebf703383a","step_index":0,"state":"DONE","step_type":"user_input"}}',
  '{"event":"step_update","step_update":{"conversation_id":"abad2b3a-2b63-46bb-a909-1bebf703383a","step_index":1,"state":"DONE","step_type":"agent_response","duration_seconds":3.2525209999999998,"usage":{"input_tokens":18560,"output_tokens":112,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":18672}}}',
  '{"event":"step_update","step_update":{"conversation_id":"abad2b3a-2b63-46bb-a909-1bebf703383a","step_index":2,"state":"ACTIVE","step_type":"tool","tool_name":"view_file","tool_info":{"name":"view_file","parameters":{"AbsolutePath":"/tmp/agyprobe/does-not-exist.txt"}}}}',
  '{"event":"step_update","step_update":{"conversation_id":"abad2b3a-2b63-46bb-a909-1bebf703383a","step_index":2,"state":"ERROR","step_type":"tool","tool_name":"view_file","duration_seconds":0.122475,"tool_info":{"name":"view_file","parameters":{"AbsolutePath":"/tmp/agyprobe/does-not-exist.txt"},"error":{"type":"TOOL_ERROR","message":"declaring permissions: cortex tool view_file: convert tool call for permissions: model output error: invalid tool call error (invalid_args) failed to read file: stat /tmp/agyprobe/does-not-exist.txt: no such file or directory"}}}}',
  '{"event":"step_update","step_update":{"conversation_id":"abad2b3a-2b63-46bb-a909-1bebf703383a","step_index":3,"state":"ACTIVE","step_type":"agent_response","text_delta":"RECOVERED"}}',
  '{"event":"step_update","step_update":{"conversation_id":"abad2b3a-2b63-46bb-a909-1bebf703383a","step_index":3,"state":"DONE","step_type":"agent_response","text_delta":"\\n","duration_seconds":2.144518,"usage":{"input_tokens":18868,"output_tokens":3,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":18871}}}',
  '{"event":"result","result":{"conversation_id":"abad2b3a-2b63-46bb-a909-1bebf703383a","status":"SUCCESS","response":"RECOVERED\\n","duration_seconds":5.517985,"num_turns":1,"usage":{"input_tokens":37428,"output_tokens":115,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":37543}}}',
].join("\n");

/**
 * Headless mode auto-denies write_file (no --dangerously-skip-permissions); agy reports
 * SUCCESS with an empty response and `denied_actions`.
 */
export const DENIED_ACTION_RUN = [
  '{"event":"init","conversation_id":"b524dbae-fb81-4901-acd9-70c8ba14d489","init":{"model":"gemini-3.8-flash-low","cwd":"/tmp/agyprobe","tools":["view_file","write_to_file","run_command"],"permission_mode":"request-review"}}',
  '{"event":"step_update","step_update":{"conversation_id":"b524dbae-fb81-4901-acd9-70c8ba14d489","step_index":0,"state":"DONE","step_type":"user_input"}}',
  '{"event":"step_update","step_update":{"conversation_id":"b524dbae-fb81-4901-acd9-70c8ba14d489","step_index":1,"state":"DONE","step_type":"agent_response","duration_seconds":3.4427659999999998,"usage":{"input_tokens":18481,"output_tokens":239,"thinking_tokens":107,"cache_read_tokens":0,"total_tokens":18720}}}',
  '{"event":"step_update","step_update":{"conversation_id":"b524dbae-fb81-4901-acd9-70c8ba14d489","step_index":2,"state":"ACTIVE","step_type":"tool","tool_name":"write_to_file","tool_info":{"name":"write_to_file","parameters":{"TargetFile":"/tmp/agyprobe/note.txt"}}}}',
  '{"event":"step_update","step_update":{"conversation_id":"b524dbae-fb81-4901-acd9-70c8ba14d489","step_index":2,"state":"ERROR","step_type":"tool","tool_name":"write_to_file","duration_seconds":0.299051,"tool_info":{"name":"write_to_file","parameters":{"TargetFile":"/tmp/agyprobe/note.txt"},"error":{"type":"TOOL_ERROR","message":"permission check failed for write_file \\"/tmp/agyprobe/note.txt\\": user denied permission for write_file(/tmp/agyprobe/note.txt)\\nDo not attempt to circumvent this denial by rephrasing the command, using alternative tools/scripts (e.g. python, sh, curl), or accessing the same target resource. Proceed without performing this action."}}}}',
  '{"event":"result","result":{"conversation_id":"b524dbae-fb81-4901-acd9-70c8ba14d489","status":"SUCCESS","response":"","duration_seconds":3.814682,"num_turns":1,"usage":{"input_tokens":18481,"output_tokens":239,"thinking_tokens":107,"cache_read_tokens":0,"total_tokens":18720},"denied_actions":[{"action":"write_file","display_name":"WriteToFile"}]}}',
].join("\n");
