export const APP_LOCALE = "pt-BR";

const statusLabels: Record<string, string> = {
  active: "Ativo",
  paused: "Pausado",
  idle: "Ocioso",
  running: "Em execução",
  error: "Erro",
  pending_approval: "Aguardando aprovação",
  terminated: "Encerrado",
  backlog: "Backlog",
  todo: "A fazer",
  in_progress: "Em andamento",
  in_review: "Em revisão",
  done: "Concluído",
  blocked: "Bloqueado",
  cancelled: "Cancelado",
  planned: "Planejado",
  completed: "Concluído",
  archived: "Arquivado",
  queued: "Na fila",
  succeeded: "Concluído",
  failed: "Falhou",
  timed_out: "Expirado",
  revision_requested: "Revisão solicitada",
};

const priorityLabels: Record<string, string> = {
  critical: "Crítica",
  high: "Alta",
  medium: "Média",
  low: "Baixa",
};

const entityTypeLabels: Record<string, string> = {
  issue: "Tarefa",
  agent: "Agente",
  project: "Projeto",
  goal: "Meta",
  approval: "Aprovação",
  heartbeat_run: "Execução",
  company: "Empresa",
};

function humanizeKey(value: string): string {
  return value
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function translateStatus(status: string): string {
  return statusLabels[status] ?? humanizeKey(status);
}

export function translatePriority(priority: string): string {
  return priorityLabels[priority] ?? humanizeKey(priority);
}

export function translateEntityType(entityType: string): string {
  return entityTypeLabels[entityType] ?? humanizeKey(entityType);
}

export function translateValueLabel(value: string): string {
  return statusLabels[value] ?? priorityLabels[value] ?? humanizeKey(value);
}

export function formatRelativeTime(date: Date | string): string {
  const now = Date.now();
  const then = new Date(date).getTime();
  const diffSec = Math.round((now - then) / 1000);

  if (diffSec < 60) return "agora";

  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `há ${diffMin} min`;

  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `há ${diffHr} h`;

  const diffDay = Math.round(diffHr / 24);
  if (diffDay < 7) return `há ${diffDay} d`;

  const diffWeek = Math.round(diffDay / 7);
  if (diffWeek < 5) return `há ${diffWeek} sem`;

  const diffMonth = Math.round(diffDay / 30);
  return `há ${diffMonth} ${diffMonth === 1 ? "mês" : "meses"}`;
}
