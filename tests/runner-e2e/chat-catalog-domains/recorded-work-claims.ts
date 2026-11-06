import type { Entity } from "./internal-support.js";

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const mentions = (value: string, name: string | undefined) => !!name && new RegExp(`(?<![\\w-])${escape(name)}(?![\\w-])`, "i").test(value);
export function recordedTaskUnits(reply: string, target: Entity, knownTasks: Entity[]) {
  const units: Array<{ taskId: string; text: string }> = [];
  let current: { taskId: string; text: string } | undefined;
  for (const line of reply.split(/\n/)) {
    if (!line.trim()) { current = undefined; continue; }
    if (/^\s*(?:[-*]|\d+\.|#{1,6})\s/.test(line)) current = undefined;
    for (const sentence of line.split(/(?<=[.!?;])\s+/)) {
      const prose = sentence.replace(/(?:https?:\/\/|(?<![\w])\/)[^\s)\x60\]>]+/gi, "");
      const companyPrefixes = knownTasks.flatMap(task => task.identifier?.match(/^(.+-)\d+$/)?.[1]?.toLowerCase() ?? []);
      const explicitIdentifiers = (prose.match(/(?<![\w-])[A-Z][A-Z0-9]*-\d+(?![\w-])/gi) ?? [])
        .filter(value => companyPrefixes.some(prefix => value.toLowerCase().startsWith(prefix)));
      const textIdentifiers = knownTasks.filter(task => mentions(prose, task.identifier));
      const urlIdentifiers = knownTasks.filter(task => [task.id, task.identifier].some(id => !!id && new RegExp(`/issues/${escape(id)}(?![\\w-])`, "i").test(sentence)));
      const unknownIssueResource = /\/issues\/(?:[a-f0-9]{8}-[a-f0-9-]{27}|[A-Z][A-Z0-9]*-\d+)(?![\w-])/i.test(sentence) && !urlIdentifiers.length;
      const identifiers = unknownIssueResource ? [] : textIdentifiers.length ? textIdentifiers : explicitIdentifiers.length ? [] : urlIdentifiers;
      let subjects = identifiers.length ? identifiers : explicitIdentifiers.length || unknownIssueResource ? [] : knownTasks.filter(task => mentions(prose, task.title));
      if (!identifiers.length) subjects = subjects.filter(task => !subjects.some(other => other.id !== task.id && other.title !== task.title && other.title?.includes(task.title ?? "")));
      const ids = [...new Set(subjects.map(task => task.id))];
      if (ids.length === 1) { current = { taskId: ids[0]!, text: sentence }; units.push(current); }
      else if (ids.length > 1 || explicitIdentifiers.length || unknownIssueResource) current = undefined;
      else if (current) current.text += ` ${sentence}`;
    }
  }
  return units.filter(unit => unit.taskId === target.id).map(unit => unit.text);
}
const states = {
  in_progress: { yes: /\b(?:active|in.progress|underway)\b/i, no: /\b(?:not (?:active|in.progress|underway)|(?:is|remains|now) (?:blocked|done|completed|backlog))\b/i, otherCells: /\|\s*(?:blocked|done|completed|backlog)\s*\|/i },
  blocked: { yes: /\bblocked\b/i, no: /\b(?:not blocked|no longer blocked|unblocked|(?:is|now) (?:done|completed|ready))\b/i, otherCells: /\|\s*(?:done|completed|backlog|in.progress)\s*\|/i },
  done: { yes: /\b(?:done|completed|finished)\b/i, no: /\b(?:not (?:done|completed|finished)|still (?:running|pending)|(?:is|remains) (?:backlog|blocked|in.progress))\b/i, otherCells: /\|\s*(?:backlog|blocked|in.progress)\s*\|/i },
  backlog: { yes: /\bbacklog\b/i, no: /\b(?:not (?:in )?backlog|done|completed|finished)\b/i, otherCells: /\|\s*(?:blocked|in.progress|active)\s*\|/i },
} as const;
export function reportsRecordedTaskState(reply: string, task: Entity, knownTasks: Entity[], state: keyof typeof states) {
  const units = recordedTaskUnits(reply, task, knownTasks), rule = states[state];
  const contrary = {
    in_progress: /(?:[—:]|\b(?:is|remains|now))\s*(?:blocked|done|completed|backlog)\b/i,
    blocked: /(?:[—:]|\b(?:is|remains|now))\s*(?:in.progress|done|completed|backlog|ready)\b/i,
    done: /(?:[—:]|\b(?:is|remains|now))\s*(?:in.progress|blocked|backlog)\b/i,
    backlog: /(?:[—:]|\b(?:is|remains|now))\s*(?:in.progress|blocked|done|completed)\b/i,
  }[state];
  const wrong = (unit: string) => rule.no.test(unit) || rule.otherCells.test(unit) || contrary.test(unit);
  return units.some(unit => rule.yes.test(unit) && !wrong(unit)) && !units.some(wrong);
}
export function groundedOverviewBlocker(reply: string, blocked: Entity, knownTasks: Entity[], recordedBlocker: unknown) {
  const reason = "approved launch colors";
  if (typeof recordedBlocker !== "string" || !(recordedBlocker === reason || recordedBlocker.startsWith(`${reason} `))
    || blocked.status !== "blocked" || blocked.description !== `Waiting for ${recordedBlocker}.`) return false;
  const units = recordedTaskUnits(reply, blocked, knownTasks);
  const resolved = /\b(?:not|no longer) (?:blocked|waiting|awaiting)\b|\b(?:is|now|already) (?:ready|unblocked|resolved)\b|\bcan (?:proceed|start)\b|\b(?:colors|palette) (?:are|is|were|was|have been|has been) (?:already )?approved\b/i;
  const claimsResolution = (unit: string) => resolved.test(unit.replace(/\b(?:until|once|when|if|after)\b[^.!?;]{0,100}\b(?:colors|palette) (?:are|is|were|was|have been|has been) (?:already )?approved\b/gi, ""));
  return units.some(unit => unit.includes(reason) && /\b(?:blocked|waiting|awaits?|awaiting|pending|needs?)\b/i.test(unit) && !claimsResolution(unit))
    && !units.some(claimsResolution);
}
export function reportsRecordedCaseRole(reply: string, task: Entity, linkedTasks: Entity[], role: "work" | "reference") {
  const units = recordedTaskUnits(reply, task, linkedTasks);
  const work = /\b(?:primary|main|initial investigation)\b|\|\s*work\s*\|/i;
  const reference = /\b(?:linked|reference)\b|\|\s*reference\s*\|/i;
  const yes = role === "work" ? work : reference;
  const other = role === "work" ? /\|\s*reference\s*\||\b(?:is|as|role[: ]+) (?:a |the )?reference\b/i : /\|\s*work\s*\||\b(?:is|as|role[: ]+) (?:a |the )?(?:primary|main)\b/i;
  const denied = role === "work" ? /\bnot (?:the |a )?(?:primary|main|work task)\b/i : /\bnot (?:the |a )?(?:linked|reference)\b/i;
  return units.some(unit => yes.test(unit) && !other.test(unit) && !denied.test(unit)) && !units.some(unit => other.test(unit) || denied.test(unit));
}
export function explicitlyUnrelatedWork(reply: string, unrelated: Entity, knownTasks: Entity[]) {
  const units = recordedTaskUnits(reply, unrelated, knownTasks);
  const negative = /\b(?:not tied|explicitly unrelated|not (?:linked|related|connected)|no case link|not part of (?:the |this )?case)\b/i;
  const affirmative = /\b(?:is|actually|now|also) (?:a |the )?(?:linked|related|reference|primary|main)\b|\b(?:part of|belongs to) (?:the |this )?case\b|\|\s*(?:work|reference)\s*\|/i;
  return units.length > 0 && units.every(unit => negative.test(unit) && !affirmative.test(unit.replace(/\b(?:not tied|explicitly unrelated|not (?:linked|related|connected)|no case link|not part of (?:the |this )?case)\b/gi, "")));
}

export function privateWorkUndisclosed(reply: string, links: string[], task: Entity, marker: unknown) {
  if (!task.id || !task.title || typeof marker !== "string" || !marker) return false;
  const lower = reply.toLowerCase();
  if (lower.includes(task.title.toLowerCase()) || lower.includes(marker.toLowerCase())) return false;
  const opaqueId = /^[a-f0-9]{8}-[a-f0-9-]{27}$/i.test(task.id) ? task.id : undefined;
  if (mentions(reply, opaqueId) || mentions(reply, task.identifier)) return false;
  return links.every(href => {
    try { const decoded = decodeURIComponent(href); return !mentions(decoded, task.id) && !mentions(decoded, task.identifier) && !decoded.toLowerCase().includes(marker.toLowerCase()); }
    catch { return false; }
  });
}
