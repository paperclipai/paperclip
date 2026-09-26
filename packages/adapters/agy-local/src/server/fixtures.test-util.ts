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
