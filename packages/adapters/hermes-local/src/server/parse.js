
import { TOOL_NAME_MAP } from '../shared/constants.js';
import { stripAnsi } from '../shared/utils.js';

export const SESSION_ID_REGEX = /^session_id:\s*(\S+)/m;
export const SESSION_ID_REGEX_LEGACY = /session[_ ](?:id|saved)[:\s]+([A-Za-z0-9_-]+)/i;
export const TOKEN_USAGE_REGEX = /tokens?[:\s]+(\d+)\s*(?:input|in)\b.*?(\d+)\s*(?:output|out)\b/i;
export const COST_REGEX = /(?:cost|spent)[:\s]*\$?([\d.]+)/i;
export const UNKNOWN_SESSION_PATTERNS = [
  /unknown session/i,
  /session .* not found/i,
  /resume .* failed/i,
];

const HERMES_BANNER_HEADER_REGEX = /^╭[─\s]*.+\sv\d+(?:\.\d+)+(?:\s*\([^)]+\))?\s*[─\s]*╮$/iu;
const HERMES_BORDER_FOOTER_REGEX = /^╰[─]+╯$/;
const HERMES_COMPACT_BANNER_TOP_REGEX = /^╔═+╗$/u;
const HERMES_COMPACT_BANNER_BOTTOM_REGEX = /^╚═+╝$/u;
const HERMES_COMPACT_BANNER_LINE_REGEX = /(?:NOUS HERMES|Messenger of the Digital Gods)/iu;
const HERMES_REASONING_HEADER_REGEX = /^┌─\s*Reasoning\s*─*┐$/i;
const HERMES_REASONING_FOOTER_REGEX = /^└─+┘$/;
const HERMES_THINKING_PREVIEW_REGEX = /^\[thinking\]\s*(.*)$/i;
const HERMES_SEPARATOR_REGEX = /^─{8,}$/;
const HERMES_TOOL_SPINNER_REGEX = /^\[tool\]\s+/i;
const HERMES_QUERY_HEADER_REGEX = /^Query:\s*/i;
const HERMES_INIT_LINE_REGEX = /^Initializing agent\.\.\.$/i;
const HERMES_RESUME_HEADER_REGEX = /^Resume this session with:$/i;
const HERMES_RESUME_COMMAND_REGEX = /^hermes --resume\b/i;
const HERMES_RESUME_TITLE_COMMAND_REGEX = /^hermes\s+-c\b/i;
const HERMES_SESSION_SUMMARY_REGEX = /^(?:Session|Title|Duration|Messages):\s+/i;
const HERMES_HONCHO_SESSION_REGEX = /^Honcho session:/i;
const HERMES_CONTEXT_PRESSURE_REGEX = /^\S?.*context .* to compaction/i;
const HERMES_CONTEXT_STATUS_REGEX = /^\[@ context:\s+\d+\s+ref\(s\),\s+\d+\s+tokens\]$/i;
const HERMES_WARNING_STATUS_REGEX = /^⚠(?:️)?\s+/u;
const HERMES_INIT_FAILURE_REGEX = /^Failed to initialize agent:/i;
const HERMES_SESSION_NOT_FOUND_REGEX = /^Session not found:/i;
const HERMES_SESSION_HINT_REGEX = /^Use a session ID from a previous CLI run/i;
const HERMES_DIFF_FILE_HEADER_REGEX = /^(.+?)\s+→\s+(.+)$/u;
const HERMES_DIFF_TRUNCATION_REGEX = /^… omitted \d+ diff line\(s\)/u;
const HERMES_TOOL_DURATION_REGEX = /\s+(\d+(?:\.\d+)?s)\s*(?:\(([\d.]+s)\))?\s*$/i;
const HERMES_TOOL_FAILURE_REGEX = /\s+\[(error|full|exit \d+)\]\s*$/i;
const HERMES_PREPARING_TOOL_REGEX = /^preparing\s+([a-z0-9_:-]+)(?:…|\.{3})$/i;
const HERMES_BARE_BANNER_ROW_REGEXES = [
  /^Available Tools$/i,
  /^MCP Servers$/i,
  /^Available Skills$/i,
  /^No skills installed$/i,
  /^Profile:\s+.+$/i,
  /^\d+\s+tools\b.*\/help for commands\b/i,
  /^⚠\s+\d+\s+commits?\s+behind\b/i,
];

function normalizeHermesLine(value) {
  return stripAnsi(value).replace(/\r/g, '').trimEnd();
}

function isHermesBannerHeader(line) {
  return HERMES_BANNER_HEADER_REGEX.test(line);
}

function isHermesPanelHeader(line) {
  return line.startsWith('╭─') && line.endsWith('╮') && !isHermesBannerHeader(line);
}

function isHermesPanelFooter(line) {
  return HERMES_BORDER_FOOTER_REGEX.test(line);
}

function isHermesCompactBannerTop(line) {
  return HERMES_COMPACT_BANNER_TOP_REGEX.test(line);
}

function isHermesCompactBannerBottom(line) {
  return HERMES_COMPACT_BANNER_BOTTOM_REGEX.test(line);
}

function isHermesCompactBannerLine(line) {
  return HERMES_COMPACT_BANNER_LINE_REGEX.test(line);
}

function isHermesReasoningHeader(line) {
  return HERMES_REASONING_HEADER_REGEX.test(line);
}

function isHermesReasoningFooter(line) {
  return HERMES_REASONING_FOOTER_REGEX.test(line);
}

function isHermesSessionIdLine(line) {
  return SESSION_ID_REGEX.test(line);
}

function isHermesThinkingPreviewLine(line) {
  return HERMES_THINKING_PREVIEW_REGEX.test(line);
}

function isHermesSessionSummaryLine(line) {
  return HERMES_SESSION_SUMMARY_REGEX.test(line);
}

function isHermesResumeHeader(line) {
  return HERMES_RESUME_HEADER_REGEX.test(line);
}

function isHermesResumeCommand(line) {
  return HERMES_RESUME_COMMAND_REGEX.test(line);
}

function isHermesResumeTitleCommand(line) {
  return HERMES_RESUME_TITLE_COMMAND_REGEX.test(line);
}

function isHermesQueryHeader(line) {
  return HERMES_QUERY_HEADER_REGEX.test(line);
}

function isHermesInitLine(line) {
  return HERMES_INIT_LINE_REGEX.test(line);
}

function isHermesSeparatorLine(line) {
  return HERMES_SEPARATOR_REGEX.test(line);
}

function isHermesSuppressedMetadataLine(line) {
  return (
    isHermesSessionIdLine(line)
    || isHermesResumeHeader(line)
    || isHermesResumeCommand(line)
    || isHermesResumeTitleCommand(line)
    || isHermesSessionSummaryLine(line)
    || isHermesInitLine(line)
    || isHermesSeparatorLine(line)
    || isHermesCompactBannerLine(line)
    || HERMES_HONCHO_SESSION_REGEX.test(line)
    || HERMES_CONTEXT_PRESSURE_REGEX.test(line)
  );
}

function isHermesBareBannerRow(line) {
  return HERMES_BARE_BANNER_ROW_REGEXES.some((pattern) => pattern.test(line));
}

function isHermesQueryTerminator(line) {
  return (
    isHermesInitLine(line)
    || isHermesSeparatorLine(line)
    || isHermesPanelHeader(line)
    || isHermesReasoningHeader(line)
    || isHermesResumeHeader(line)
    || isHermesSessionIdLine(line)
    || parseToolCompletionLine(line) !== null
  );
}

function normalizeHermesPanelContent(line) {
  const trimmed = line.trim();
  if (trimmed.startsWith('│') && trimmed.endsWith('│')) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function cleanupAssistantBlock(lines) {
  const normalized = [];
  let blankStreak = 0;
  for (const rawLine of lines) {
    const line = normalizeHermesPanelContent(rawLine);
    if (!line) {
      blankStreak += 1;
      if (blankStreak <= 1) normalized.push('');
      continue;
    }
    blankStreak = 0;
    normalized.push(line);
  }

  while (normalized[0] === '') normalized.shift();
  while (normalized[normalized.length - 1] === '') normalized.pop();
  return normalized.join('\n').trim();
}

function extractHermesResponseBlocks(stdout) {
  const lines = stripAnsi(stdout).replace(/\r/g, '').split('\n');
  const blocks = [];
  let inBanner = false;
  let inCompactBanner = false;
  let inQuery = false;
  let inResponsePanel = false;
  let currentBlock = [];

  const flushBlock = () => {
    if (currentBlock.length === 0) return;
    const text = cleanupAssistantBlock(currentBlock);
    currentBlock = [];
    if (text) blocks.push(text);
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();
    if (!trimmed) {
      if (inResponsePanel) currentBlock.push('');
      continue;
    }

    if (inBanner) {
      if (isHermesPanelFooter(trimmed)) inBanner = false;
      continue;
    }

    if (inCompactBanner) {
      if (isHermesCompactBannerBottom(trimmed)) inCompactBanner = false;
      continue;
    }

    if (isHermesBannerHeader(trimmed)) {
      inBanner = true;
      continue;
    }

    if (isHermesCompactBannerTop(trimmed)) {
      inCompactBanner = true;
      continue;
    }

    if (isHermesCompactBannerLine(trimmed)) {
      continue;
    }

    if (inQuery) {
      if (isHermesQueryTerminator(trimmed)) {
        inQuery = false;
      } else {
        continue;
      }
    }

    if (inResponsePanel) {
      if (
        isHermesPanelHeader(trimmed)
        || isHermesPanelFooter(trimmed)
        || isHermesResumeHeader(trimmed)
        || isHermesSessionIdLine(trimmed)
      ) {
        flushBlock();
        inResponsePanel = false;
        if (isHermesPanelHeader(trimmed)) inResponsePanel = true;
        continue;
      }
      currentBlock.push(line);
      continue;
    }

    if (isHermesQueryHeader(trimmed)) {
      inQuery = true;
      continue;
    }

    if (isHermesPanelHeader(trimmed)) {
      inResponsePanel = true;
      continue;
    }

    if (isHermesSuppressedMetadataLine(trimmed)) {
      continue;
    }
  }

  if (inResponsePanel) flushBlock();
  return blocks;
}

function fallbackCleanResponse(value) {
  const normalizedLines = stripAnsi(value).replace(/\r/g, '').split('\n');
  const kept = [];
  let inCompactBanner = false;
  let inReasoningBox = false;
  let inThinkingPreview = false;

  for (const rawLine of normalizedLines) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();
    if (!trimmed) {
      inThinkingPreview = false;
      kept.push('');
      continue;
    }
    if (inCompactBanner) {
      if (isHermesCompactBannerBottom(trimmed)) inCompactBanner = false;
      continue;
    }
    if (inReasoningBox) {
      if (isHermesReasoningFooter(trimmed)) inReasoningBox = false;
      continue;
    }
    if (inThinkingPreview) {
      if (
        isHermesPanelHeader(trimmed)
        || isHermesReasoningHeader(trimmed)
        || isHermesResumeHeader(trimmed)
        || isHermesSessionIdLine(trimmed)
        || parseToolCompletionLine(trimmed)
        || isHermesPreparingToolLine(trimmed)
      ) {
        inThinkingPreview = false;
      } else {
        continue;
      }
    }
    if (trimmed.startsWith('[tool]')) continue;
    if (trimmed.startsWith('[hermes]')) continue;
    if (trimmed.startsWith('[paperclip]')) continue;
    if (trimmed.startsWith('session_id:')) continue;
    if (/^\[\d{4}-\d{2}-\d{2}T/.test(trimmed)) continue;
    if (isHermesCompactBannerTop(trimmed)) {
      inCompactBanner = true;
      continue;
    }
    if (isHermesCompactBannerLine(trimmed)) continue;
    if (isHermesReasoningHeader(trimmed)) {
      inReasoningBox = true;
      continue;
    }
    if (isHermesThinkingPreviewLine(trimmed)) {
      inThinkingPreview = true;
      continue;
    }
    if (isHermesReasoningFooter(trimmed)) continue;
    if (isHermesBareBannerRow(trimmed)) continue;
    if (isHermesToolDiffHeader(trimmed)) continue;
    if (isHermesInlineAssistantLine(trimmed)) {
      kept.push(extractHermesInlineAssistantText(trimmed));
      continue;
    }
    if (parseToolCompletionLine(trimmed)) continue;
    if (isHermesPreparingToolLine(trimmed)) continue;
    kept.push(trimmed);
  }

  return kept
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * @param {string} value
 */
export function cleanResponse(value) {
  const responseBlocks = extractHermesResponseBlocks(value);
  if (responseBlocks.length > 0) {
    return responseBlocks.join('\n\n').trim();
  }
  return fallbackCleanResponse(value);
}

/**
 * @param {string} stdout
 * @param {string} stderr
 */
export function parseHermesOutput(stdout, stderr) {
  const result = {
    sessionId: null,
    response: '',
    usage: null,
    costUsd: null,
    errorMessage: '',
  };

  const sessionMatch = stdout.match(SESSION_ID_REGEX);
  if (sessionMatch?.[1]) {
    result.sessionId = sessionMatch[1];
    const index = stdout.lastIndexOf('\nsession_id:');
    result.response = cleanResponse(index > 0 ? stdout.slice(0, index) : stdout.replace(SESSION_ID_REGEX, ''));
  } else {
    const combined = `${stdout}\n${stderr}`;
    const legacy = combined.match(SESSION_ID_REGEX_LEGACY);
    if (legacy?.[1]) result.sessionId = legacy[1];
    result.response = cleanResponse(stdout);
  }

  const usageMatch = `${stdout}\n${stderr}`.match(TOKEN_USAGE_REGEX);
  if (usageMatch) {
    result.usage = {
      inputTokens: Number(usageMatch[1]) || 0,
      outputTokens: Number(usageMatch[2]) || 0,
    };
  }

  const costMatch = `${stdout}\n${stderr}`.match(COST_REGEX);
  if (costMatch?.[1]) result.costUsd = Number(costMatch[1]);

  const errorLines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => /error|exception|traceback|failed/i.test(line))
    .filter((line) => !/INFO|DEBUG|WARN|WARNING/.test(line));

  if (errorLines.length) result.errorMessage = errorLines.slice(0, 5).join('\n');

  return result;
}

export function isUnknownSessionError(stdout, stderr) {
  const combined = `${stdout}\n${stderr}`;
  return UNKNOWN_SESSION_PATTERNS.some((pattern) => pattern.test(combined));
}

function stripHermesToolPrefix(line) {
  let cleaned = line.replace(/^\[done\]\s*/i, '').trim();
  const toolFeed = splitHermesToolFeedLine(cleaned);
  if (!toolFeed) return null;
  cleaned = toolFeed.display;
  if (!cleaned) return null;

  const failureMatch = cleaned.match(HERMES_TOOL_FAILURE_REGEX);
  const failureLabel = failureMatch?.[1]?.toLowerCase() || null;
  if (failureMatch) {
    cleaned = cleaned.slice(0, failureMatch.index).trimEnd();
  }

  const durationMatch = cleaned.match(HERMES_TOOL_DURATION_REGEX);
  const duration = durationMatch?.[1] || '';
  if (durationMatch) {
    cleaned = cleaned.slice(0, durationMatch.index).trimEnd();
  }

  cleaned = cleaned.replace(/^[^A-Za-z0-9$]+/u, '').trimStart();
  return {
    display: cleaned,
    duration,
    hasError: Boolean(failureLabel),
    failureLabel,
    hasTimingOrFailure: Boolean(durationMatch || failureMatch),
  };
}

function parseHermesToolLabel(display) {
  const matchers = [
    { pattern: /^search\s+(.*)$/i, name: 'search', buildInput: (detail) => ({ query: detail }) },
    { pattern: /^fetch\s+(.*)$/i, name: 'fetch', buildInput: (detail) => ({ target: detail }) },
    { pattern: /^crawl\s+(.*)$/i, name: 'crawl', buildInput: (detail) => ({ url: detail }) },
    { pattern: /^\$\s+(.*)$/i, name: 'shell', buildInput: (detail) => ({ command: detail }) },
    { pattern: /^proc\s+(.*)$/i, name: 'process', buildInput: (detail) => ({ target: detail }) },
    { pattern: /^read\s+(.*)$/i, name: 'read', buildInput: (detail) => ({ path: detail }) },
    { pattern: /^write\s+(.*)$/i, name: 'write', buildInput: (detail) => ({ path: detail }) },
    { pattern: /^patch\s+(.*)$/i, name: 'patch', buildInput: (detail) => ({ path: detail }) },
    { pattern: /^(?:grep|find)\s+(.*)$/i, name: 'search', buildInput: (detail) => ({ pattern: detail }) },
    { pattern: /^navigate\s+(.*)$/i, name: 'browser', buildInput: (detail) => ({ url: detail }) },
    { pattern: /^snapshot\b(?:\s+(.*))?$/i, name: 'browser', buildInput: (detail) => ({ target: detail || 'snapshot' }) },
    { pattern: /^click\b(?:\s+(.*))?$/i, name: 'browser', buildInput: (detail) => ({ target: detail || 'click' }) },
    { pattern: /^type\s+(.*)$/i, name: 'browser', buildInput: (detail) => ({ text: detail }) },
    { pattern: /^scroll\b(?:\s+(.*))?$/i, name: 'browser', buildInput: (detail) => ({ target: detail || 'scroll' }) },
    { pattern: /^(?:back|press|close|images)\b(?:\s+(.*))?$/i, name: 'browser', buildInput: (detail) => ({ target: detail || 'browser' }) },
    { pattern: /^vision\s+analyzing page$/i, name: 'browser', buildInput: () => ({ target: 'vision' }) },
    { pattern: /^vision\b(?:\s+(.*))?$/i, name: 'vision', buildInput: (detail) => ({ question: detail || 'vision' }) },
    { pattern: /^plan\b(?:\s+(.*))?$/i, name: 'plan', buildInput: (detail) => ({ target: detail || 'plan' }) },
    { pattern: /^recall\s+(.*)$/i, name: 'recall', buildInput: (detail) => ({ query: detail }) },
    { pattern: /^memory\b(?:\s+(.*))?$/i, name: 'memory', buildInput: (detail) => ({ target: detail || 'memory' }) },
    { pattern: /^skills\s+(.*)$/i, name: 'skills', buildInput: (detail) => ({ target: detail }) },
    { pattern: /^skills?\s+(.*)$/i, name: 'skill', buildInput: (detail) => ({ name: detail }) },
    { pattern: /^create\s+(.*)$/i, name: 'image', buildInput: (detail) => ({ prompt: detail }) },
    { pattern: /^speak\s+(.*)$/i, name: 'speech', buildInput: (detail) => ({ text: detail }) },
    { pattern: /^reason\s+(.*)$/i, name: 'reason', buildInput: (detail) => ({ prompt: detail }) },
    { pattern: /^send\s+(.*)$/i, name: 'message', buildInput: (detail) => ({ message: detail }) },
    { pattern: /^cron\b(?:\s+(.*))?$/i, name: 'cron', buildInput: (detail) => ({ target: detail || 'cron' }) },
    { pattern: /^rl\b(?:\s+(.*))?$/i, name: 'rl', buildInput: (detail) => ({ target: detail || 'rl' }) },
    { pattern: /^exec\s+(.*)$/i, name: 'execute_code', buildInput: (detail) => ({ command: detail }) },
    { pattern: /^delegate\s+(.*)$/i, name: 'delegate', buildInput: (detail) => ({ target: detail }) },
  ];

  for (const matcher of matchers) {
    const match = display.match(matcher.pattern);
    if (!match) continue;
    const detail = (match[1] || '').trim();
    return {
      name: matcher.name,
      detail,
      input: matcher.buildInput(detail),
    };
  }

  const generic = display.match(/^([a-z0-9_.-]+)\b(?:\s+(.*))?$/i);
  if (!generic) return null;
  const verb = generic[1];
  const detail = (generic[2] || '').trim();
  return {
    name: TOOL_NAME_MAP[verb.toLowerCase()] || verb,
    detail,
    input: detail ? { target: detail } : {},
  };
}

/**
 * Lightweight parser for Hermes transcript stdout lines.
 *
 * @param {string} line
 * @param {string} ts
 */
export function parseHermesStdoutLine(line, ts) {
  return createHermesStdoutParser().parseLine(line, ts);
}

/**
 * @param {string} line
 */
export function parseToolCompletionLine(line) {
  const normalized = normalizeHermesLine(line).trim();
  const stripped = stripHermesToolPrefix(normalized);
  if (!stripped?.display) return null;
  if (HERMES_PREPARING_TOOL_REGEX.test(stripped.display)) return null;
  if (!stripped.hasTimingOrFailure) return null;

  const parsed = parseHermesToolLabel(stripped.display);
  if (!parsed) return null;
  const resultLines = [`status: ${stripped.hasError ? 'failed' : 'completed'}`];
  if (stripped.failureLabel?.startsWith('exit ')) {
    resultLines.push(`exit_code: ${stripped.failureLabel.slice('exit '.length)}`);
  }
  if (stripped.duration) resultLines.push(`duration: ${stripped.duration}`);
  if (parsed.detail) {
    resultLines.push('');
    resultLines.push(parsed.detail);
  }

  return {
    name: parsed.name,
    detail: parsed.detail,
    input: parsed.input,
    detailWithDuration: resultLines.join('\n').trim(),
    hasError: stripped.hasError,
  };
}

function splitHermesToolFeedLine(line) {
  const match = line.match(/^(\S+)\s+(.*)$/u);
  if (!match) return null;
  const prefix = match[1];
  const display = (match[2] || '').trim();
  if (!isHermesToolPrefix(prefix) || !display) return null;
  return { prefix, display };
}

function isHermesToolPrefix(prefix) {
  return prefix.length > 0 && prefix.length <= 4 && /[^\p{L}\p{N}_$]/u.test(prefix);
}

function isHermesPreparingToolLine(line) {
  return Boolean(stripHermesToolPrefix(line)?.display.match(HERMES_PREPARING_TOOL_REGEX));
}

function isHermesToolDiffHeader(line) {
  const stripped = stripHermesToolPrefix(line);
  return Boolean(stripped?.display && /^review diff$/i.test(stripped.display));
}

function isHermesInlineAssistantLine(line) {
  const stripped = stripHermesToolPrefix(line);
  return Boolean(stripped?.display && stripped.display.startsWith('💬'));
}

function extractHermesInlineAssistantText(line) {
  const stripped = stripHermesToolPrefix(line);
  if (!stripped?.display) return line.trim();
  return stripped.display.replace(/^💬\s*/, '').trim();
}

function parseHermesDiffLine(line, ts) {
  if (HERMES_DIFF_TRUNCATION_REGEX.test(line)) {
    return { kind: 'diff', ts, changeType: 'truncation', text: line };
  }

  const fileHeader = line.match(HERMES_DIFF_FILE_HEADER_REGEX);
  if (fileHeader) {
    return { kind: 'diff', ts, changeType: 'file_header', text: `${fileHeader[1]} -> ${fileHeader[2]}` };
  }
  if (line.startsWith('@@')) {
    return { kind: 'diff', ts, changeType: 'hunk', text: line };
  }
  if (line.startsWith('+')) {
    return { kind: 'diff', ts, changeType: 'add', text: line };
  }
  if (line.startsWith('-')) {
    return { kind: 'diff', ts, changeType: 'remove', text: line };
  }
  return { kind: 'diff', ts, changeType: 'context', text: line };
}

export function createHermesStdoutParser() {
  let inBanner = false;
  let inCompactBanner = false;
  let inQuery = false;
  let inReasoningBox = false;
  let inThinkingPreview = false;
  let inResponsePanel = false;
  let inResumeHint = false;
  let inDiffPreview = false;

  return {
    parseLine(line, ts) {
      const normalized = normalizeHermesLine(line);
      const trimmed = normalized.trim();
      if (!trimmed) return [];

      if (inBanner) {
        if (isHermesPanelFooter(trimmed)) inBanner = false;
        return [];
      }

      if (inCompactBanner) {
        if (isHermesCompactBannerBottom(trimmed)) inCompactBanner = false;
        return [];
      }

      if (inReasoningBox) {
        if (isHermesReasoningFooter(trimmed)) {
          inReasoningBox = false;
          return [];
        }
        return [{ kind: 'thinking', ts, text: normalizeHermesPanelContent(normalized) }];
      }

      if (inThinkingPreview) {
        if (
          isHermesPanelHeader(trimmed)
          || isHermesReasoningHeader(trimmed)
          || isHermesResumeHeader(trimmed)
          || isHermesSessionIdLine(trimmed)
          || isHermesSuppressedMetadataLine(trimmed)
        ) {
          inThinkingPreview = false;
        } else {
          const tool = parseToolCompletionLine(trimmed);
          if (tool || isHermesPreparingToolLine(trimmed)) {
            inThinkingPreview = false;
          } else {
            return [{ kind: 'thinking', ts, text: trimmed }];
          }
        }
      }

      if (isHermesBannerHeader(trimmed)) {
        inBanner = true;
        return [];
      }

      if (isHermesCompactBannerTop(trimmed)) {
        inCompactBanner = true;
        return [];
      }

      if (isHermesCompactBannerLine(trimmed)) {
        return [];
      }

      if (inQuery) {
        if (isHermesQueryTerminator(trimmed)) {
          inQuery = false;
        } else {
          return [];
        }
      }

      if (inResponsePanel) {
        if (isHermesPanelFooter(trimmed)) {
          inResponsePanel = false;
          return [];
        }
        if (isHermesSessionIdLine(trimmed)) {
          inResponsePanel = false;
          return [];
        }
        if (isHermesResumeHeader(trimmed)) {
          inResponsePanel = false;
          inResumeHint = true;
          return [];
        }
        if (isHermesPanelHeader(trimmed)) {
          return [];
        }
        return [{ kind: 'assistant', ts, text: normalizeHermesPanelContent(normalized) }];
      }

      if (inResumeHint) {
        if (
          isHermesResumeCommand(trimmed)
          || isHermesResumeTitleCommand(trimmed)
          || isHermesSessionSummaryLine(trimmed)
        ) {
          return [];
        }
        inResumeHint = false;
      }

      if (inDiffPreview) {
        if (isHermesPanelHeader(trimmed)) {
          inDiffPreview = false;
          inResponsePanel = true;
          return [];
        }
        if (isHermesSuppressedMetadataLine(trimmed)) {
          inDiffPreview = false;
          if (isHermesResumeHeader(trimmed)) inResumeHint = true;
          return [];
        }
        if (isHermesToolDiffHeader(trimmed)) {
          return [];
        }
        return [parseHermesDiffLine(trimmed, ts)];
      }

      if (trimmed.startsWith('[hermes]') || trimmed.startsWith('[paperclip]')) {
        return [{ kind: 'system', ts, text: trimmed }];
      }

      if (HERMES_CONTEXT_STATUS_REGEX.test(trimmed)) {
        return [{ kind: 'system', ts, text: trimmed }];
      }

      if (HERMES_TOOL_SPINNER_REGEX.test(trimmed)) {
        return [];
      }

      if (/^\[\d{4}-\d{2}-\d{2}T/.test(trimmed)) {
        return [{ kind: 'stderr', ts, text: trimmed }];
      }

      if (HERMES_CONTEXT_PRESSURE_REGEX.test(trimmed)) {
        return [];
      }

      if (
        HERMES_INIT_FAILURE_REGEX.test(trimmed)
        || HERMES_SESSION_NOT_FOUND_REGEX.test(trimmed)
        || HERMES_SESSION_HINT_REGEX.test(trimmed)
        || HERMES_WARNING_STATUS_REGEX.test(trimmed)
      ) {
        return [{ kind: 'stderr', ts, text: trimmed }];
      }

      if (isHermesPanelHeader(trimmed)) {
        inResponsePanel = true;
        return [];
      }

      if (isHermesReasoningHeader(trimmed)) {
        inReasoningBox = true;
        return [];
      }

      const thinkingPreview = trimmed.match(HERMES_THINKING_PREVIEW_REGEX);
      if (thinkingPreview) {
        inThinkingPreview = true;
        return thinkingPreview[1]
          ? [{ kind: 'thinking', ts, text: thinkingPreview[1] }]
          : [];
      }

      if (isHermesQueryHeader(trimmed)) {
        inQuery = true;
        return [];
      }

      if (isHermesResumeHeader(trimmed)) {
        inResumeHint = true;
        return [];
      }

      if (isHermesSuppressedMetadataLine(trimmed)) {
        return [];
      }

      if (isHermesToolDiffHeader(trimmed)) {
        inDiffPreview = true;
        return [];
      }

      if (isHermesInlineAssistantLine(trimmed)) {
        return [{ kind: 'assistant', ts, text: extractHermesInlineAssistantText(trimmed) }];
      }

      if (isHermesPreparingToolLine(trimmed)) {
        return [];
      }

      const tool = parseToolCompletionLine(trimmed);
      if (tool) {
        const toolUseId = `hermes-tool-${stableToolId(trimmed, ts)}`;
        return [
          { kind: 'tool_call', ts, name: tool.name, input: tool.input, toolUseId },
          { kind: 'tool_result', ts, toolUseId, toolName: tool.name, content: tool.detailWithDuration, isError: tool.hasError },
        ];
      }

      if (/error|traceback/i.test(trimmed)) {
        return [{ kind: 'stderr', ts, text: trimmed }];
      }

      return [{ kind: 'assistant', ts, text: trimmed }];
    },
    reset() {
      inBanner = false;
      inCompactBanner = false;
      inQuery = false;
      inReasoningBox = false;
      inThinkingPreview = false;
      inResponsePanel = false;
      inResumeHint = false;
      inDiffPreview = false;
    },
  };
}

/**
 * @param {string} raw
 * @param {string} ts
 */
function stableToolId(raw, ts) {
  const source = `${ts}:${raw}`;
  let hash = 0;
  for (let i = 0; i < source.length; i += 1) {
    hash = (hash * 31 + source.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16);
}
