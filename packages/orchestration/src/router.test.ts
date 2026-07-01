import { describe, expect, it } from 'vitest';
import {
  EXAMPLE_POLICY,
  RouterPolicyViolationError,
  route,
  type RouterDependencies,
  type RoutingRule,
  type TaskDescriptor,
} from './index.js';

/** Every test injects the reference policy — the core ships no rules of its own. */
function deps(extra: Omit<RouterDependencies, 'policy'> = {}): RouterDependencies {
  return { policy: EXAMPLE_POLICY, ...extra };
}

const PRIMARY_ENGINE_BY_TASK = Object.fromEntries(
  EXAMPLE_POLICY.map((r): [string, RoutingRule['primary']] => [r.task_type, r.primary]),
);

describe('orchestration.route — empty default policy', () => {
  it('throws when no policy is injected (core ships DEFAULT_POLICY = [])', () => {
    expect(() =>
      route({ task_type: 'strategy_positioning_board', sensitivity: 'internal' }),
    ).toThrow(/No routing rule/);
  });
});

describe('orchestration.route — policy grid coverage (all rows)', () => {
  // One assertion per routing-grid row.
  for (const rule of EXAMPLE_POLICY) {
    it(`${rule.task_type} → primary engine ${rule.primary}`, () => {
      const descriptor: TaskDescriptor = {
        task_type: rule.task_type,
        sensitivity: 'internal',
        // Tier 2 rule must opt in to automation; everything else stays Tier 1.
        ...(rule.tier === 2 ? { automation: true } : {}),
      };
      const decision = route(descriptor, deps({ geminiAvailable: true }));
      expect(decision.engine).toBe(rule.primary);
      expect(decision.role).toBe(rule.role);
      expect(decision.tier).toBe(rule.tier);
      expect(decision.justification[0]).toBe(rule.rationale);
    });
  }
});

describe('orchestration.route — sensitivity gate', () => {
  it('outbound regulatory text gets a cross-vendor second-pass model', () => {
    const decision = route(
      {
        task_type: 'regulated_domain_reasoning',
        sensitivity: 'regulatory',
        estimated_input_tokens: 12_000,
      },
      deps({ geminiAvailable: true }),
    );
    expect(decision.engine).toBe('claude');
    expect(decision.fallback).toBeDefined();
    expect(decision.fallback?.engine).not.toBe(decision.engine);
    expect(decision.complexity_class).toBe('critical');
    expect(decision.human_sign_off_required).toBe(true);
  });

  it('outbound sensitivity with an unsatisfiable context size throws', () => {
    expect(() =>
      route(
        {
          task_type: 'creative_copy_iteration',
          sensitivity: 'outbound',
          estimated_input_tokens: 999_999_999,
        },
        deps({ geminiAvailable: false }),
      ),
    ).toThrow();
  });

  it('internal Simple task does not require sign-off or fallback', () => {
    const decision = route(
      {
        task_type: 'simple_classification_format',
        sensitivity: 'internal',
        expected_complexity: 'simple',
      },
      deps(),
    );
    expect(decision.human_sign_off_required).toBe(false);
    expect(decision.fallback).toBeUndefined();
  });
});

describe('orchestration.route — Tier escalation guard', () => {
  it('background_automation_bulk without automation=true throws RouterPolicyViolationError', () => {
    expect(() =>
      route({ task_type: 'background_automation_bulk', sensitivity: 'internal' }, deps()),
    ).toThrow(RouterPolicyViolationError);
  });

  it('background_automation_bulk with automation=true routes to API tier 2', () => {
    const decision = route(
      {
        task_type: 'background_automation_bulk',
        sensitivity: 'internal',
        automation: true,
      },
      deps(),
    );
    expect(decision.engine).toBe('api');
    expect(decision.tier).toBe(2);
  });
});

describe('orchestration.route — edge cases', () => {
  it('long-context >200k outbound regulatory text → document-engine ingestion + reasoning pass marker', () => {
    const decision = route(
      {
        task_type: 'regulated_domain_reasoning',
        sensitivity: 'regulatory',
        estimated_input_tokens: 350_000,
      },
      deps({ geminiAvailable: true }),
    );
    // Promotion: long-context kicks engine to the document engine, reasoning becomes the second-pass.
    expect(decision.engine).toBe('gemini');
    expect(decision.fallback?.engine).toBe('claude');
    expect(decision.justification.some((line) => line.includes('Long-context promotion'))).toBe(
      true,
    );
    expect(decision.human_sign_off_required).toBe(true);
  });

  it('Critical client copy without explicit complexity → reasoning default + cross-vendor red team', () => {
    const decision = route(
      {
        task_type: 'creative_copy_iteration',
        sensitivity: 'critical',
      },
      deps(),
    );
    // Critical sensitivity floors complexity → Critical → reasoning red-team selected.
    expect(decision.complexity_class).toBe('critical');
    expect(decision.fallback?.engine).toBe('claude');
    expect(decision.engine).toBe(PRIMARY_ENGINE_BY_TASK['creative_copy_iteration']);
    expect(decision.human_sign_off_required).toBe(true);
  });

  it('multimodal UX prototyping → ChatGPT primary; document engine secondary only when document-heavy', () => {
    const decision = route(
      {
        task_type: 'multimodal_ux_prototyping',
        sensitivity: 'internal',
        requires_multimodal: true,
      },
      deps(),
    );
    expect(decision.engine).toBe('chatgpt');
  });

  it('web research / sourcing → Perplexity + reasoning pass marker on outbound', () => {
    const decision = route(
      {
        task_type: 'web_research_sourcing',
        sensitivity: 'outbound',
      },
      deps(),
    );
    expect(decision.engine).toBe('perplexity');
    expect(decision.fallback?.engine).toBe('claude');
  });

  it('bulk parsing / cron without automation flag → fail-fast', () => {
    expect(() =>
      route({ task_type: 'background_automation_bulk', sensitivity: 'internal' }, deps()),
    ).toThrow(RouterPolicyViolationError);
  });
});

describe('orchestration.route — model selection cost discipline', () => {
  it('Simple internal task picks the cheapest tier model (no top-tier model on Simple)', () => {
    const decision = route(
      {
        task_type: 'simple_classification_format',
        sensitivity: 'internal',
        expected_complexity: 'simple',
      },
      deps(),
    );
    expect(decision.engine).toBe('claude');
    expect(decision.model).toBe('claude-haiku-4-5');
  });

  it('Complex strategy task escalates to the flagship + cross-vendor red-team', () => {
    const decision = route(
      {
        task_type: 'strategy_positioning_board',
        sensitivity: 'outbound',
        expected_complexity: 'complex',
      },
      deps(),
    );
    expect(decision.engine).toBe('claude');
    expect(decision.model).toBe('claude-opus-4-7');
    expect(decision.fallback?.engine).toBe('chatgpt');
  });

  it('Estimated cost reflects token count × catalog price', () => {
    const decision = route(
      {
        task_type: 'simple_classification_format',
        sensitivity: 'internal',
        expected_complexity: 'simple',
        estimated_input_tokens: 100_000,
      },
      deps(),
    );
    // Haiku at 80 cents per 1M tokens; 100k tokens → 8 cents.
    expect(decision.model).toBe('claude-haiku-4-5');
    expect(decision.estimated_cost_eur_cents).toBe(8);
  });
});

describe('orchestration.route — confidence', () => {
  it('drops below 1.0 when the descriptor omits estimated_input_tokens and complexity hint', () => {
    const decision = route(
      {
        task_type: 'strategy_positioning_board',
        sensitivity: 'internal',
      },
      deps(),
    );
    expect(decision.confidence).toBeLessThan(1);
  });
});

describe('orchestration.route — agent policy soft signals', () => {
  it('preferredEngine matching rule.secondary swaps primary↔secondary', () => {
    // strategy_positioning_board: primary=claude, secondary=chatgpt.
    const decision = route(
      {
        task_type: 'strategy_positioning_board',
        sensitivity: 'outbound',
        expected_complexity: 'complex',
        agent_policy: { preferredEngine: 'chatgpt' },
      },
      deps(),
    );
    expect(decision.engine).toBe('chatgpt');
    expect(decision.fallback?.engine).toBe('claude');
    expect(decision.justification.some((line) => line.includes('preferredEngine=chatgpt'))).toBe(
      true,
    );
  });

  it('preferredEngine=gemini does not re-run long-context promotion after swap', () => {
    // multimodal_ux_prototyping: primary=chatgpt, secondary=gemini. Once the
    // preference swaps primary to gemini, long-context promotion must not clobber
    // the intended chatgpt second pass.
    const decision = route(
      {
        task_type: 'multimodal_ux_prototyping',
        sensitivity: 'outbound',
        expected_complexity: 'complex',
        estimated_input_tokens: 350_000,
        agent_policy: { preferredEngine: 'gemini' },
      },
      deps({ geminiAvailable: true }),
    );
    expect(decision.engine).toBe('gemini');
    expect(decision.fallback?.engine).toBe('chatgpt');
    expect(decision.justification.some((line) => line.includes('Long-context promotion'))).toBe(
      false,
    );
  });

  it('preferredEngine that is not in {primary, secondary} is silently ignored', () => {
    // regulated_domain_reasoning: primary=claude, secondary=chatgpt. gemini is
    // not allowed → preference is dropped, reasoning engine stays primary. This
    // is also the regulatory-floor guardrail: a regulated task cannot be
    // downgraded to a document-engine primary via agent config alone.
    const decision = route(
      {
        task_type: 'regulated_domain_reasoning',
        sensitivity: 'regulatory',
        estimated_input_tokens: 12_000,
        agent_policy: { preferredEngine: 'gemini' },
      },
      deps({ geminiAvailable: true }),
    );
    expect(decision.engine).toBe('claude');
    expect(decision.justification.some((line) => line.includes('ignored'))).toBe(true);
  });

  it('preferredEngine equal to current engine is a no-op', () => {
    const decision = route(
      {
        task_type: 'strategy_positioning_board',
        sensitivity: 'internal',
        agent_policy: { preferredEngine: 'claude' },
      },
      deps(),
    );
    expect(decision.engine).toBe('claude');
    expect(decision.justification.some((line) => line.includes('preferredEngine'))).toBe(false);
  });

  it('expectedComplexity=high promotes the model tier when the descriptor omits the explicit hint', () => {
    // simple_classification_format default complexity = simple → haiku.
    // agent policy bumps to "high" → complex → opus.
    const decision = route(
      {
        task_type: 'simple_classification_format',
        sensitivity: 'internal',
        agent_policy: { expectedComplexity: 'high' },
      },
      deps(),
    );
    expect(decision.complexity_class).toBe('complex');
    expect(decision.model).toBe('claude-opus-4-7');
  });

  it('expectedComplexity=low keeps the cheapest model when the rule default is medium', () => {
    // code_review_refactor default complexity = medium → sonnet.
    // agent policy hint "low" → simple → haiku (cheaper economy tier).
    const decision = route(
      {
        task_type: 'code_review_refactor',
        sensitivity: 'internal',
        agent_policy: { expectedComplexity: 'low' },
      },
      deps(),
    );
    expect(decision.complexity_class).toBe('simple');
    expect(decision.model).toBe('claude-haiku-4-5');
  });

  it('descriptor.expected_complexity wins over agent_policy.expectedComplexity (caller-explicit beats config)', () => {
    const decision = route(
      {
        task_type: 'simple_classification_format',
        sensitivity: 'internal',
        expected_complexity: 'simple',
        agent_policy: { expectedComplexity: 'high' },
      },
      deps(),
    );
    expect(decision.complexity_class).toBe('simple');
    expect(decision.model).toBe('claude-haiku-4-5');
  });

  it('agent_policy.expectedComplexity is still floored by sensitivity (regulatory → critical)', () => {
    const decision = route(
      {
        task_type: 'regulated_domain_reasoning',
        sensitivity: 'regulatory',
        agent_policy: { expectedComplexity: 'low' },
      },
      deps(),
    );
    // Sensitivity floor for regulatory is critical — agent hint cannot lower it.
    expect(decision.complexity_class).toBe('critical');
  });
});
