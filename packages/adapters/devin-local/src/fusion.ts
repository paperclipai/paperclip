import type {
  AdapterModelFusion,
  AdapterModelFusionComponent,
  AdapterModelTokenRates,
} from '@paperclipai/adapter-utils';

export function isFusionModelId(value: string): boolean {
  return /^fusion(?:-|$)/i.test(value.trim());
}

export function fusionSelectionError(model: string): string | null {
  return model.trim().toLowerCase() === 'fusion'
    ? 'Choose an explicit Fusion combination; select an orchestrator and worker.'
    : null;
}

const UID_EFFORT_TOKENS = new Set([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'thinking',
]);
const UID_MODIFIER_TOKENS = new Set(['fast', '1m', 'priority']);
const LABEL_EFFORT_WORDS = new Set(UID_EFFORT_TOKENS);
const LABEL_MODIFIER_WORDS = new Set(['fast', 'priority', '1m']);

const EFFORT_DISPLAY: Record<string, string> = {
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'XHigh',
  max: 'Max',
  thinking: 'Thinking',
};

function opaque(costSummary: string | null): AdapterModelFusion {
  return {
    version: 1,
    kind: 'fusion',
    components: null,
    rates: null,
    costSummary,
  };
}

interface ParsedUidComponent {
  id: string;
  modelKey: string;
  effort: string | null;
  modifiers: string[];
}

function parseUidComponent(segment: string): ParsedUidComponent | null {
  const tokens = segment.split('-');
  if (tokens.some((t) => t === '')) return null;
  if (tokens.length === 0) return null;
  const modifiers: string[] = [];
  while (tokens.length > 0 && UID_MODIFIER_TOKENS.has(tokens[tokens.length - 1])) {
    modifiers.unshift(tokens.pop()!);
  }
  let effort: string | null = null;
  if (tokens.length > 0 && UID_EFFORT_TOKENS.has(tokens[tokens.length - 1])) {
    effort = tokens.pop()!;
  }
  if (tokens.length === 0) return null;
  for (const t of tokens) {
    if (UID_EFFORT_TOKENS.has(t) || UID_MODIFIER_TOKENS.has(t)) return null;
  }
  return {
    id: segment,
    modelKey: tokens.join('-'),
    effort,
    modifiers,
  };
}

interface ParsedLabelComponent {
  modelLabel: string;
  effort: string | null;
  raw: string;
}

function parseLabelComponent(part: string): ParsedLabelComponent | null {
  const raw = part.trim();
  const words = raw.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return null;
  while (
    words.length > 0 &&
    LABEL_MODIFIER_WORDS.has(words[words.length - 1].toLowerCase())
  ) {
    words.pop();
  }
  if (
    words.length > 1 &&
    words[words.length - 1].toLowerCase() === 'thinking' &&
    LABEL_EFFORT_WORDS.has(words[words.length - 2].toLowerCase())
  ) {
    words.pop();
  }
  let effort: string | null = null;
  if (
    words.length > 0 &&
    LABEL_EFFORT_WORDS.has(words[words.length - 1].toLowerCase())
  ) {
    effort = words.pop()!.toLowerCase();
  }
  if (words.length === 0) return null;
  const last = words[words.length - 1].toLowerCase();
  if (LABEL_EFFORT_WORDS.has(last) || LABEL_MODIFIER_WORDS.has(last)) {
    return null;
  }
  return { modelLabel: words.join(' '), effort, raw };
}

const RATE_SEGMENT_NAMES: Record<
  string,
  { role: 'orchestrator' | 'worker'; field: keyof AdapterModelTokenRates }
> = {
  input: { role: 'orchestrator', field: 'inputPerMillion' },
  in: { role: 'orchestrator', field: 'inputPerMillion' },
  'cached input': { role: 'orchestrator', field: 'cachedInputPerMillion' },
  output: { role: 'orchestrator', field: 'outputPerMillion' },
  out: { role: 'orchestrator', field: 'outputPerMillion' },
  'sidekick input': { role: 'worker', field: 'inputPerMillion' },
  'sidekick in': { role: 'worker', field: 'inputPerMillion' },
  'sidekick cached input': { role: 'worker', field: 'cachedInputPerMillion' },
  'sidekick output': { role: 'worker', field: 'outputPerMillion' },
  'sidekick out': { role: 'worker', field: 'outputPerMillion' },
};

function parseFusionRates(
  costSummary: string | null,
): AdapterModelFusion['rates'] {
  if (!costSummary) return null;
  const fields = new Map<string, number | null>();
  for (const segment of costSummary.split('·')) {
    const entry = /^(.+?)\s*\/\s*(?:1M|MTok)\s+(.+)$/i.exec(segment.trim());
    if (!entry) continue;
    const name = entry[2].trim().toLowerCase().replace(/\s+/g, ' ');
    if (!Object.hasOwn(RATE_SEGMENT_NAMES, name)) continue;
    const target = RATE_SEGMENT_NAMES[name];
    const amount = /^\$\s*(\d+(?:\.\d+)?)$/.exec(entry[1].trim());
    const parsed = amount ? Number(amount[1]) : NaN;
    const value = Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
    const key = `${target.role}:${target.field}`;
    if (!fields.has(key)) {
      fields.set(key, value);
    } else if (fields.get(key) !== value) {
      fields.set(key, null);
    }
  }
  if (fields.size === 0) return null;
  return {
    orchestrator: {
      inputPerMillion: fields.get('orchestrator:inputPerMillion') ?? null,
      cachedInputPerMillion:
        fields.get('orchestrator:cachedInputPerMillion') ?? null,
      outputPerMillion: fields.get('orchestrator:outputPerMillion') ?? null,
    },
    worker: {
      inputPerMillion: fields.get('worker:inputPerMillion') ?? null,
      cachedInputPerMillion: fields.get('worker:cachedInputPerMillion') ?? null,
      outputPerMillion: fields.get('worker:outputPerMillion') ?? null,
    },
  };
}

export function parseFusionVariant(
  uid: string,
  label: string,
  costSummary: string | null,
): AdapterModelFusion {
  const rawCost = typeof costSummary === 'string' ? costSummary : null;
  const rates = parseFusionRates(rawCost);
  const id = uid.trim();
  const prefix = id.match(/^fusion-/i);
  if (!prefix) return { ...opaque(rawCost), rates };
  const rest = id.slice(prefix[0].length);
  const segments = rest.split('-sidekick-');
  if (segments.length !== 2 || segments.some((s) => s.length === 0)) {
    return { ...opaque(rawCost), rates };
  }
  const orchestratorUid = parseUidComponent(segments[0]);
  const workerUid = parseUidComponent(segments[1]);
  if (!orchestratorUid || !workerUid) {
    return { ...opaque(rawCost), rates };
  }

  const labelText = typeof label === 'string' ? label.trim() : '';
  const wrapper = labelText.match(/^Fusion \((.*)\)$/);
  if (!wrapper) return { ...opaque(rawCost), rates };
  const parts = wrapper[1].split(' + ');
  if (parts.length !== 2) return { ...opaque(rawCost), rates };
  const orchestratorLabel = parseLabelComponent(parts[0]);
  const workerLabel = parseLabelComponent(parts[1]);
  if (!orchestratorLabel || !workerLabel) {
    return { ...opaque(rawCost), rates };
  }

  const build = (
    u: ParsedUidComponent,
    l: ParsedLabelComponent,
  ): AdapterModelFusionComponent | null => {
    if (u.effort && l.effort && u.effort !== l.effort) return null;
    const modelLabel = l.modelLabel;
    if (u.effort) {
      return {
        id: u.id,
        modelKey: u.modelKey,
        modelLabel,
        effortKey: u.effort,
        effortLabel: EFFORT_DISPLAY[u.effort] ?? u.effort,
        effortSource: 'uid',
        label: l.raw,
        modifiers: u.modifiers,
      };
    }
    if (l.effort) {
      const tier = EFFORT_DISPLAY[l.effort] ?? l.effort;
      return {
        id: u.id,
        modelKey: u.modelKey,
        modelLabel,
        effortKey: `fixed:${u.id}`,
        effortLabel: `${tier} (fixed)`,
        effortSource: 'label_fixed',
        label: l.raw,
        modifiers: u.modifiers,
      };
    }
    return {
      id: u.id,
      modelKey: u.modelKey,
      modelLabel,
      effortKey: `unspecified:${u.id}`,
      effortLabel: 'Not specified by catalog',
      effortSource: 'unspecified',
      label: l.raw,
      modifiers: u.modifiers,
    };
  };

  const orchestrator = build(orchestratorUid, orchestratorLabel);
  const worker = build(workerUid, workerLabel);
  if (!orchestrator || !worker) return { ...opaque(rawCost), rates };
  return {
    version: 1,
    kind: 'fusion',
    components: { orchestrator, worker },
    rates,
    costSummary: rawCost,
  };
}
