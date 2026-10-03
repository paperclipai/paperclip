"use strict";
/**
 * Paperclip UI parser contract 1.0 for the agy adapter.
 *
 * The host reads this file's *source* and evaluates it inside a locked-down Web
 * Worker (no network, no storage, no imports). It must therefore stay a single
 * self-contained CommonJS file with no requires, and export
 * `parseStdoutLine(line, ts) -> TranscriptEntry[]`.
 *
 * Input is one line of `agy --output-format stream-json` NDJSON.
 */

function asRecord(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value;
}

function asText(value) {
  return typeof value === "string" ? value : "";
}

function asTrimmed(value) {
  return asText(value).trim();
}

function asNumber(value) {
  return typeof value === "number" && isFinite(value) ? value : 0;
}

/** Stable id so the ACTIVE tool_call and the DONE tool_result pair up in the UI. */
function toolUseId(conversationId, stepIndex) {
  return (conversationId || "agy") + ":" + stepIndex;
}

/**
 * Render tool parameters into a short one-line detail. agy reports different
 * key names per tool (TargetFile, AbsolutePath, Command, …), so prefer the
 * recognizable ones and fall back to the first string value.
 */
function summarizeParameters(parameters) {
  if (!parameters) return "";
  var preferred = [
    "TargetFile",
    "AbsolutePath",
    "Path",
    "File",
    "Command",
    "CommandLine",
    "Query",
    "SearchTerm",
    "Url",
    "URL",
    "DirectoryPath",
  ];
  for (var i = 0; i < preferred.length; i += 1) {
    var value = parameters[preferred[i]];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  var keys = Object.keys(parameters);
  for (var j = 0; j < keys.length; j += 1) {
    var candidate = parameters[keys[j]];
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return "";
}

function parseInitEvent(event, ts) {
  var init = asRecord(event.init) || {};
  var entries = [
    {
      kind: "init",
      ts: ts,
      // agy's init event does not carry the model id; the run meta reports it.
      model: asTrimmed(init.model) || "antigravity",
      sessionId: asTrimmed(event.conversation_id),
    },
  ];
  var cwd = asTrimmed(init.cwd);
  if (cwd) {
    entries.push({ kind: "system", ts: ts, text: "workspace: " + cwd });
  }
  return entries;
}

function parseStepUpdateEvent(event, ts) {
  var step = asRecord(event.step_update);
  if (!step) return [];

  var stepType = asTrimmed(step.step_type);
  var state = asTrimmed(step.state);
  var conversationId = asTrimmed(step.conversation_id);

  if (stepType === "agent_response") {
    var delta = asText(step.text_delta);
    if (delta.length === 0) return [];
    // text_delta is a genuine incremental chunk, so mark it as a delta and let
    // the UI concatenate rather than replacing the message each time.
    return [{ kind: "assistant", ts: ts, text: delta, delta: true }];
  }

  if (stepType === "tool") {
    var stepIndex = asNumber(step.step_index);
    var toolInfo = asRecord(step.tool_info) || {};
    var name = asTrimmed(step.tool_name) || asTrimmed(toolInfo.name) || "tool";
    var id = toolUseId(conversationId, stepIndex);
    var parameters = asRecord(toolInfo.parameters);

    if (state === "DONE") {
      var output = asTrimmed(toolInfo.output);
      var hasError = toolInfo.error !== undefined && toolInfo.error !== null;
      var detail = summarizeParameters(parameters);
      var content = output || (detail ? name + " " + detail : name + " completed");
      return [
        {
          kind: "tool_result",
          ts: ts,
          toolUseId: id,
          toolName: name,
          content: content,
          isError: hasError,
        },
      ];
    }

    return [
      {
        kind: "tool_call",
        ts: ts,
        name: name,
        input: parameters || {},
        toolUseId: id,
      },
    ];
  }

  if (stepType === "user_input") {
    var userText = asTrimmed(step.text_delta);
    return userText ? [{ kind: "user", ts: ts, text: userText }] : [];
  }

  return [];
}

function parseResultEvent(event, ts) {
  var result = asRecord(event.result);
  if (!result) return [];
  var usage = asRecord(result.usage) || {};
  var status = asTrimmed(result.status);
  var isError = status.length > 0 && status !== "SUCCESS";
  var errorText = asTrimmed(result.error) || asTrimmed(result.error_message);
  return [
    {
      kind: "result",
      ts: ts,
      text: status || "done",
      inputTokens: asNumber(usage.input_tokens),
      outputTokens: asNumber(usage.output_tokens),
      cachedTokens: asNumber(usage.cache_read_tokens),
      // agy runs on an Antigravity subscription and reports no per-run price.
      costUsd: 0,
      subtype: status.toLowerCase(),
      isError: isError,
      errors: isError && errorText ? [errorText] : [],
    },
  ];
}

function parseStdoutLine(line, ts) {
  var trimmed = asTrimmed(line);
  if (trimmed.length === 0) return [];

  // Anything agy writes outside the NDJSON stream (banners, panics) is plain
  // output and should still be visible rather than dropped.
  if (trimmed.charAt(0) !== "{") {
    if (/^(?:error|panic|fatal)\b/i.test(trimmed)) {
      return [{ kind: "stderr", ts: ts, text: trimmed }];
    }
    return [{ kind: "stdout", ts: ts, text: trimmed }];
  }

  var event;
  try {
    event = asRecord(JSON.parse(trimmed));
  } catch (err) {
    return [{ kind: "stdout", ts: ts, text: trimmed }];
  }
  if (!event) return [{ kind: "stdout", ts: ts, text: trimmed }];

  var kind = asTrimmed(event.event);
  if (kind === "init") return parseInitEvent(event, ts);
  if (kind === "step_update") return parseStepUpdateEvent(event, ts);
  if (kind === "result") return parseResultEvent(event, ts);

  // Unknown event type — surface it verbatim so protocol drift is visible in
  // the run log instead of silently disappearing.
  return [{ kind: "stdout", ts: ts, text: trimmed }];
}

module.exports = { parseStdoutLine: parseStdoutLine };
