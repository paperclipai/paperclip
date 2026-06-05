/** Reference routing policy.
 *
 *  This is an EXAMPLE table demonstrating how a tenant wires task types to
 *  engines. The core ships no rules of its own (`DEFAULT_POLICY` is empty); a
 *  tenant supplies a table like this via `RouterDependencies.policy`. Task type
 *  ids are opaque to the core — define whatever taxonomy fits your domain.
 *
 *  Each row maps a task category to a primary engine, an optional cross-vendor
 *  second-pass engine, a default complexity, and the tier it lives in.
 */

import type { RoutingRule } from './policy.js';

export const EXAMPLE_POLICY: ReadonlyArray<RoutingRule> = [
  {
    task_type: 'strategy_positioning_board',
    primary: 'claude',
    secondary: 'chatgpt',
    role: 'reasoning',
    default_complexity: 'complex',
    tier: 1,
    rationale: 'Strategy / positioning / board materials → reasoning engine, cross-vendor red-team',
  },
  {
    task_type: 'regulated_domain_reasoning',
    primary: 'claude',
    secondary: 'chatgpt',
    role: 'reasoning',
    default_complexity: 'critical',
    tier: 1,
    rationale: 'Regulated-domain reasoning + outbound text → reasoning engine + cross-vendor pass + human sign-off',
  },
  {
    task_type: 'workflow_orchestration',
    primary: 'chatgpt',
    secondary: 'claude',
    role: 'orchestration',
    default_complexity: 'medium',
    tier: 1,
    rationale: 'Workflow orchestration / agent coordination → orchestration engine, reasoning on decision nodes',
  },
  {
    task_type: 'multimodal_ux_prototyping',
    primary: 'chatgpt',
    secondary: 'gemini',
    role: 'orchestration',
    default_complexity: 'medium',
    tier: 1,
    rationale: 'Multimodal / UX prototyping → orchestration engine, document engine only when document-heavy',
  },
  {
    task_type: 'creative_copy_iteration',
    primary: 'chatgpt',
    secondary: 'claude',
    role: 'orchestration',
    default_complexity: 'medium',
    tier: 1,
    rationale: 'Creative / presentations / copy iteration → orchestration engine, reasoning red-team',
  },
  {
    task_type: 'long_context_multidoc_compare',
    primary: 'gemini',
    secondary: 'claude',
    role: 'document',
    default_complexity: 'complex',
    tier: 1,
    rationale: 'Long-context (>200k) / multi-doc compare → document engine, reasoning for outbound',
  },
  {
    task_type: 'sop_kb_ingestion',
    primary: 'gemini',
    secondary: 'claude',
    role: 'document',
    default_complexity: 'medium',
    tier: 1,
    rationale: 'SOPs / knowledge base / manuals / studies → document engine, reasoning for critical outbound',
  },
  {
    task_type: 'workspace_sheets_dataset',
    primary: 'gemini',
    role: 'document',
    default_complexity: 'medium',
    tier: 1,
    rationale: 'Workspace / spreadsheet dataset analysis → document engine',
  },
  {
    task_type: 'meeting_transcript_action_items',
    primary: 'gemini',
    secondary: 'claude',
    role: 'document',
    default_complexity: 'simple',
    tier: 1,
    rationale: 'Meeting transcript → action items → document engine, reasoning for strategic take',
  },
  {
    task_type: 'web_research_sourcing',
    primary: 'perplexity',
    secondary: 'claude',
    role: 'research',
    default_complexity: 'medium',
    tier: 1,
    rationale: 'Web research / market monitoring / study sourcing → research engine, reasoning pass on outbound',
  },
  {
    task_type: 'realtime_news_trend_scouting',
    primary: 'perplexity',
    secondary: 'claude',
    role: 'research',
    default_complexity: 'medium',
    tier: 1,
    rationale: 'Realtime news / trend scouting → research engine, reasoning pass before outbound',
  },
  {
    task_type: 'background_automation_bulk',
    primary: 'api',
    role: 'automation',
    default_complexity: 'medium',
    tier: 2,
    rationale: 'Background automation / M2M / cron / bulk → Tier 2 API (requires automation=true)',
  },
  {
    task_type: 'simple_classification_format',
    primary: 'claude',
    role: 'reasoning',
    default_complexity: 'simple',
    tier: 1,
    rationale: 'Classification / formatting / labeling → cheapest fast model in Tier 1',
  },
  {
    task_type: 'code_review_refactor',
    primary: 'claude',
    secondary: 'chatgpt',
    role: 'reasoning',
    default_complexity: 'medium',
    tier: 1,
    rationale: 'Code review / small refactor → reasoning engine, cross-vendor red-team',
  },
];
