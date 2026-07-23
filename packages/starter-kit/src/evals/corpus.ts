/**
 * Example knowledge corpus for the starter kit's demo RAG bot. A real engagement
 * replaces this with the client's documents; the agent, retriever, and evals are
 * corpus-agnostic.
 */

export interface CorpusDoc {
  id: string;
  text: string;
  metadata?: Record<string, unknown>;
}

export const SAMPLE_CORPUS: CorpusDoc[] = [
  {
    id: 'policy_refunds',
    text: 'Our refund policy allows returns within 30 days of purchase for a full refund. Items must be unused and in original packaging. Refunds are issued to the original payment method within 5 business days.',
    metadata: { source: 'policy.md', topic: 'refunds' },
  },
  {
    id: 'hours',
    text: 'Our business hours are Monday to Friday, 9am to 5pm Eastern time. We are closed on weekends and major public holidays.',
    metadata: { source: 'hours.md', topic: 'hours' },
  },
  {
    id: 'shipping',
    text: 'Standard shipping takes 3-5 business days. Express shipping takes 1-2 business days and is available at checkout for an added fee. International shipping is available to select countries.',
    metadata: { source: 'shipping.md', topic: 'shipping' },
  },
  {
    id: 'warranty',
    text: 'All hardware includes a 12-month limited warranty covering manufacturing defects. Accidental damage is not covered. Extended warranty plans are available at purchase.',
    metadata: { source: 'warranty.md', topic: 'warranty' },
  },
];
