export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
  tokens: number;
  timestamp: number;
}

export interface ConversationContext {
  sessionId: string;
  turns: ConversationTurn[];
  totalTokens: number;
  contextLimit: number;
}

export function buildConversationContext(
  sessionId: string,
  recentTurns: ConversationTurn[],
  contextLimit: number = 8192
): ConversationContext {
  // Sum tokens from recent turns until approaching limit
  // If over limit: summarize oldest turns and replace with summary
  // Return trimmed context that fits within limit

  let totalTokens = 0;
  const turns: ConversationTurn[] = [];

  for (let i = recentTurns.length - 1; i >= 0; i--) {
    const turn = recentTurns[i];
    if (totalTokens + turn.tokens > contextLimit) {
      // Summarize remaining turns
      const remainingTurns = recentTurns.slice(0, i + 1);
      if (remainingTurns.length > 0) {
        const summary = summarizeTurns(remainingTurns);
        turns.unshift({
          role: 'assistant',
          content: `Previous context: ${summary}`,
          tokens: Math.ceil(summary.length / 4),
          timestamp: remainingTurns[0].timestamp,
        });
      }
      break;
    }
    turns.unshift(turn);
    totalTokens += turn.tokens;
  }

  return {
    sessionId,
    turns,
    totalTokens,
    contextLimit,
  };
}

export function trimToContextWindow(
  turns: ConversationTurn[],
  maxTokens: number
): ConversationTurn[] {
  // If total tokens > maxTokens:
  //   - Keep last 3 turns (most recent)
  //   - Summarize turns 4-N into single "Previous context:" turn
  //   - Return trimmed list

  const totalTokens = turns.reduce((sum, t) => sum + t.tokens, 0);

  if (totalTokens <= maxTokens) {
    return turns;
  }

  // Keep last 3 turns
  const recentTurns = turns.slice(-3);
  const remainingTurns = turns.slice(0, -3);

  if (remainingTurns.length > 0) {
    const summary = summarizeTurns(remainingTurns);
    const summaryTurn: ConversationTurn = {
      role: 'assistant',
      content: `Previous context: ${summary}`,
      tokens: Math.ceil(summary.length / 4),
      timestamp: remainingTurns[0].timestamp,
    };
    return [summaryTurn, ...recentTurns];
  }

  return recentTurns;
}

export function summarizeTurns(turns: ConversationTurn[]): string {
  // Use caveman formatting to summarize multiple turns into one line
  // Input: [turn1, turn2, turn3, turn4]
  // Output: "Did: X. Result: Y. Next: Z."

  if (turns.length === 0) return '';

  const summaries: string[] = [];

  for (const turn of turns) {
    const content = turn.content.substring(0, 50);
    if (turn.role === 'user') {
      summaries.push(`User: ${content}`);
    } else {
      summaries.push(`AI: ${content}`);
    }
  }

  return summaries.join('. ');
}