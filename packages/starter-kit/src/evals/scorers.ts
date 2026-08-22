/**
 * Eval scorers — pure functions that grade a single case.
 *
 * Each scorer returns a number in [0, 1]. The starter kit ships the four
 * scorers every client Q&A bot needs; add your own by implementing the
 * {@link Scorer} signature and dropping them into a {@link EvalCase.scorers}.
 */

export type ScorerName = 'containsExpected' | 'answerRelevance' | 'groundedness' | 'noRefusal';

export type Scorer = (caseInput: EvalCaseInput, output: EvalOutput) => number;

export interface EvalCaseInput {
  /** The user question (used by engagements; optional for direct scorer calls). */
  question?: string;
  /** Substring(s) that must appear in the answer (case-insensitive). */
  expectedContains?: string[];
  /** Source ids the answer SHOULD cite, given the retrieval. */
  expectedCitations?: string[];
  /** Whether the question is answerable from the corpus at all. */
  answerable?: boolean;
}

export interface EvalOutput {
  answer: string;
  citations: string[];
  ungrounded?: boolean;
}

export const scorers: Record<ScorerName, Scorer> = {
  // Did the answer include every expected substring?
  containsExpected: (input, out) => {
    const need = input.expectedContains ?? [];
    if (need.length === 0) return 1;
    const lower = out.answer.toLowerCase();
    const hits = need.filter((s) => lower.includes(s.toLowerCase()));
    return hits.length / need.length;
  },

  // Was the question actually answered (not dodged / refused)?
  answerRelevance: (input, out) => {
    if (out.answer.trim().length < 5) return 0;
    if (input.answerable === false) {
      // For unanswerable questions, "I don't know" is the correct relevance.
      return /don'?t know|do not know|unsure|not (have|available|found)/i.test(out.answer)
        ? 1
        : 0.2;
    }
    return 1;
  },

  // Did the answer cite sources, and were they among the expected ones?
  groundedness: (input, out) => {
    if (out.citations.length === 0) return input.answerable === false ? 1 : 0;
    const expected = input.expectedCitations ?? [];
    if (expected.length === 0) return 1; // can't be wrong if we didn't assert which
    const got = new Set(out.citations);
    const overlap = expected.filter((c) => got.has(c)).length;
    return overlap / expected.length;
  },

  // Did the model refuse when it should have (and not when it shouldn't)?
  noRefusal: (input, out) => {
    const refused = /i (can'?t|do not|don'?t)|unable to|as an ai/i.test(out.answer);
    if (input.answerable === false) return refused ? 1 : 0.5;
    return refused ? 0 : 1;
  },
};
