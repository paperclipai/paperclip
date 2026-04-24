import { useCallback, useSyncExternalStore } from "react";

const STORAGE_KEY = "paperclip-language";

export const supportedLanguages = [
  { code: "en", label: "English" },
  { code: "pt-BR", label: "Português (Brasil)" },
  { code: "es", label: "Español" },
  { code: "fr", label: "Français" },
  { code: "de", label: "Deutsch" },
  { code: "ja", label: "日本語" },
] as const;

export const localeMap: Record<string, string> = {
  en: "en-US",
  "pt-BR": "pt-BR",
  es: "es-ES",
  fr: "fr-FR",
  de: "de-DE",
  ja: "ja-JP",
};

type Bundle = Record<string, Record<string, string>>;

const en: Bundle = {
  common: {
    running: "running",
    paused: "paused",
    errors: "errors",
    open: "open",
    blocked: "blocked",
    beta: "Beta",
    skipToMainContent: "Skip to main content",
    documentation: "Documentation",
    instanceSettings: "Instance Settings",
    switchToTheme: "Switch to {{theme}} theme",
    light: "light",
    dark: "dark",
    system: "system",
  },
  sidebar: {
    selectCompany: "Select company",
    newTask: "New Task",
    dashboard: "Dashboard",
    inbox: "Inbox",
    work: "Work",
    tasks: "Tasks",
    routines: "Routines",
    goals: "Goals",
    hiring: "Hiring",
    company: "Company",
    organization: "Organization",
    skills: "Skills",
    costs: "Costs",
    activity: "Activity",
    settings: "Settings",
  },
  mobileNav: {
    home: "Home",
    tasks: "Tasks",
    create: "Create",
    agents: "Agents",
    inbox: "Inbox",
    mobileNavigation: "Mobile navigation",
  },
  dashboard: {
    title: "Dashboard",
    welcomeMessage: "Welcome to Paperclip! Create a company to get started.",
    getStarted: "Get Started",
    createOrSelectCompany: "Create or select a company to see your dashboard.",
    noAgents: "No agents yet.",
    createOneHere: "Create one here →",
    activeBudgetIncidents: "{{count}} active budget incident(s)",
    agentsPaused: "{{count}} agent(s) paused",
    projectsPaused: "{{count}} project(s) paused",
    pendingBudgetApprovals: "{{count}} pending",
    openBudgets: "Open Budgets",
    agentsEnabled: "Agents Enabled",
    tasksInProgress: "Tasks In Progress",
    monthSpend: "Month Spend",
    budgetUsage: "{{percent}}% of {{budget}} budget",
    unlimitedBudget: "Unlimited budget",
    pendingApprovals: "Pending Approvals",
    budgetOverridesAwaiting: "{{count}} budget override(s) awaiting",
    awaitingBoardReview: "Awaiting board review",
    runActivity: "Run Activity",
    issuesByPriority: "Issues by Priority",
    issuesByStatus: "Issues by Status",
    successRate: "Success Rate",
    last14Days: "Last 14 days",
    recentActivity: "Recent Activity",
    recentTasks: "Recent Tasks",
    noTasksYet: "No tasks yet.",
  },
  charts: {
    critical: "Critical",
    high: "High",
    medium: "Medium",
    low: "Low",
    todo: "To do",
    inProgress: "In Progress",
    inReview: "In Review",
    done: "Done",
    blocked: "Blocked",
    cancelled: "Cancelled",
    noRuns: "No runs yet",
  },
  instanceSettings: {
    title: "Instance Settings",
    general: "General",
    generalDescription: "Configure general instance settings.",
    language: "Language",
    languageDesc: "Choose the display language for the interface.",
    loadingSettings: "Loading settings…",
    failedToLoad: "Failed to load settings.",
    censorUsername: "Censor Username",
    censorUsernameDesc: "Hide your username in the sidebar and navigation.",
    keyboardShortcuts: "Keyboard Shortcuts",
    keyboardShortcutsDesc: "Customize keyboard shortcuts for common actions.",
    aiFeedbackSharing: "AI Feedback Sharing",
    aiFeedbackSharingDesc: "Allow sharing of AI feedback data to improve the service.",
    readTerms: "Read Terms",
    noDefaultSaved: "No default saved.",
    alwaysAllow: "Always allow",
    alwaysAllowDesc: "Automatically share AI feedback data.",
    dontAllow: "Don't allow",
    dontAllowDesc: "Never share AI feedback data.",
    signOut: "Sign Out",
    signOutDesc: "Sign out of your current session.",
    signingOut: "Signing out…",
    heartbeats: "Heartbeats",
    experimental: "Experimental",
    plugins: "Plugins",
    adapters: "Adapters",
  },
  topBarUsage: {
    monthSpend: "${{amount}}",
    ofBudget: "of ${{budget}}",
    unlimited: "Unlimited",
  },
};

const ptBR: Bundle = {
  common: {
    running: "em execução",
    paused: "pausados",
    errors: "erros",
    open: "abertos",
    blocked: "bloqueados",
    beta: "Beta",
    skipToMainContent: "Ir para o conteúdo principal",
    documentation: "Documentação",
    instanceSettings: "Configurações da Instância",
    switchToTheme: "Mudar para tema {{theme}}",
    light: "claro",
    dark: "escuro",
    system: "sistema",
  },
  sidebar: {
    selectCompany: "Selecionar empresa",
    newTask: "Nova Tarefa",
    dashboard: "Painel",
    inbox: "Caixa de Entrada",
    work: "Trabalho",
    tasks: "Tarefas",
    routines: "Rotinas",
    goals: "Metas",
    hiring: "Contratação",
    company: "Empresa",
    organization: "Organização",
    skills: "Habilidades",
    costs: "Custos",
    activity: "Atividade",
    settings: "Configurações",
  },
  mobileNav: {
    home: "Início",
    tasks: "Tarefas",
    create: "Criar",
    agents: "Agentes",
    inbox: "Caixa de Entrada",
    mobileNavigation: "Navegação mobile",
  },
  dashboard: {
    title: "Painel",
    welcomeMessage: "Bem-vindo ao Paperclip! Crie uma empresa para começar.",
    getStarted: "Começar",
    createOrSelectCompany: "Crie ou selecione uma empresa para ver seu painel.",
    noAgents: "Nenhum agente ainda.",
    createOneHere: "Crie um aqui →",
    activeBudgetIncidents: "{{count}} incidente(s) de orçamento ativo(s)",
    agentsPaused: "{{count}} agente(s) pausado(s)",
    projectsPaused: "{{count}} projeto(s) pausado(s)",
    pendingBudgetApprovals: "{{count}} pendente(s)",
    openBudgets: "Orçamentos Abertos",
    agentsEnabled: "Agentes Ativos",
    tasksInProgress: "Tarefas em Andamento",
    monthSpend: "Gasto Mensal",
    budgetUsage: "{{percent}}% de {{budget}} do orçamento",
    unlimitedBudget: "Orçamento ilimitado",
    pendingApprovals: "Aprovações Pendentes",
    budgetOverridesAwaiting: "{{count}} substituição(ões) de orçamento aguardando",
    awaitingBoardReview: "Aguardando revisão do conselho",
    runActivity: "Atividade de Execução",
    issuesByPriority: "Tarefas por Prioridade",
    issuesByStatus: "Tarefas por Status",
    successRate: "Taxa de Sucesso",
    last14Days: "Últimos 14 dias",
    recentActivity: "Atividade Recente",
    recentTasks: "Tarefas Recentes",
    noTasksYet: "Nenhuma tarefa ainda.",
  },
  charts: {
    critical: "Crítico",
    high: "Alto",
    medium: "Médio",
    low: "Baixo",
    todo: "A fazer",
    inProgress: "Em Andamento",
    inReview: "Em Revisão",
    done: "Concluído",
    blocked: "Bloqueado",
    cancelled: "Cancelado",
    noRuns: "Nenhuma execução ainda",
  },
  instanceSettings: {
    title: "Configurações da Instância",
    general: "Geral",
    generalDescription: "Configure as definições gerais da instância.",
    language: "Idioma",
    languageDesc: "Escolha o idioma de exibição da interface.",
    loadingSettings: "Carregando configurações…",
    failedToLoad: "Falha ao carregar configurações.",
    censorUsername: "Ocultar Nome de Usuário",
    censorUsernameDesc: "Ocultar seu nome de usuário na barra lateral e navegação.",
    keyboardShortcuts: "Atalhos de Teclado",
    keyboardShortcutsDesc: "Personalize os atalhos de teclado para ações comuns.",
    aiFeedbackSharing: "Compartilhamento de Feedback de IA",
    aiFeedbackSharingDesc: "Permitir o compartilhamento de dados de feedback de IA para melhorar o serviço.",
    readTerms: "Ler Termos",
    noDefaultSaved: "Nenhum padrão salvo.",
    alwaysAllow: "Sempre permitir",
    alwaysAllowDesc: "Compartilhar automaticamente dados de feedback de IA.",
    dontAllow: "Não permitir",
    dontAllowDesc: "Nunca compartilhar dados de feedback de IA.",
    signOut: "Sair",
    signOutDesc: "Encerrar sua sessão atual.",
    signingOut: "Saindo…",
    heartbeats: "Heartbeats",
    experimental: "Experimental",
    plugins: "Plugins",
    adapters: "Adaptadores",
  },
  topBarUsage: {
    monthSpend: "R${{amount}}",
    ofBudget: "de R${{budget}}",
    unlimited: "Ilimitado",
  },
};

const resources: Record<string, Bundle> = { en, "pt-BR": ptBR };

function readSavedLanguage(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? "en";
  } catch {
    return "en";
  }
}

let currentLng = readSavedLanguage();
const listeners = new Set<() => void>();

function lookup(lng: string, key: string): string | undefined {
  const parts = key.split(".");
  let value: unknown = resources[lng] ?? resources.en;
  for (const part of parts) {
    if (value == null || typeof value !== "object") return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return typeof value === "string" ? value : undefined;
}

function interpolate(template: string, values: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, name: string) => {
    const v = values[name];
    return v == null ? "" : String(v);
  });
}

export type TranslateValues = Record<string, unknown>;

export function translate(
  key: string,
  defaultOrValues?: string | TranslateValues,
  values?: TranslateValues,
): string {
  let fallback: string | undefined;
  let interpolationValues: TranslateValues | undefined;
  if (typeof defaultOrValues === "string") {
    fallback = defaultOrValues;
    interpolationValues = values;
  } else {
    interpolationValues = defaultOrValues;
  }
  const raw = lookup(currentLng, key) ?? lookup("en", key) ?? fallback ?? key;
  return interpolationValues ? interpolate(raw, interpolationValues) : raw;
}

export function saveLanguage(lng: string) {
  try {
    localStorage.setItem(STORAGE_KEY, lng);
  } catch {
    /* noop */
  }
  currentLng = lng;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getLanguage(): string {
  return currentLng;
}

export function useTranslation() {
  useSyncExternalStore(subscribe, getLanguage, getLanguage);
  const t = useCallback(
    (key: string, defaultOrValues?: string | TranslateValues, values?: TranslateValues) =>
      translate(key, defaultOrValues, values),
    [],
  );
  return { t, i18n: { language: currentLng, changeLanguage: saveLanguage } };
}

const i18n = {
  t: translate,
  changeLanguage: saveLanguage,
  get language() {
    return currentLng;
  },
};

export default i18n;
