export function firstNonEmptyLine(text: string): string {
    return (
        text
            .split(/\r?\n/)
            .map((line) => line.trim())
            .find(Boolean) ?? ""
    );
}

/**
 * Known Gemini CLI startup/diagnostic lines that appear in stderr regardless
 * of whether the run succeeds or fails. These should never be surfaced as the
 * representative error message shown to operators.
 */
const GEMINI_STDERR_NOISE_RE = [
    /^YOLO mode is enabled\b/i,
    /^missing pgrep output/i,
    /^Loaded MCP (server|tool|plugin)\b/i,
];

/**
 * Like firstNonEmptyLine, but skips known Gemini CLI startup/diagnostic noise
 * so that operators see the actual failure reason instead of e.g.
 * "YOLO mode is enabled. All tool calls will be automatically approved."
 */
export function firstMeaningfulStderrLine(text: string): string {
    return (
        text
            .split(/\r?\n/)
            .map((line) => line.trim())
            .find((line) => Boolean(line) && !GEMINI_STDERR_NOISE_RE.some((re) => re.test(line))) ?? ""
    );
}
