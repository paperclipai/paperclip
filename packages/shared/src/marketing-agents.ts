import { z } from "zod";
import type { AgentRole } from "./constants.js";

/** Stable product types, independent of Paperclip roles, runtimes and providers. */
export const MARKETING_AGENT_TYPE_IDS = [
  "cmo", "strategy_vp", "designer", "copywriter", "paid_media", "organic_media",
  "social_media", "developer", "motion_designer", "bi_analytics", "research_insights",
  "performance_coordinator",
] as const;
export type MarketingAgentTypeId = (typeof MARKETING_AGENT_TYPE_IDS)[number];

const text = z.string().trim().min(1).max(12000);
export const marketingAgentProfileSchema = z.object({
  typeId: z.enum(MARKETING_AGENT_TYPE_IDS),
  templateVersion: z.number().int().positive(),
  specialization: z.string().trim().max(500),
  responsibilities: text,
  instructions: text,
  expectedInputs: text,
  deliverables: text,
  qualityCriteria: text,
}).strict();
export type MarketingAgentProfile = z.infer<typeof marketingAgentProfileSchema>;

export interface MarketingAgentTemplate {
  id: MarketingAgentTypeId;
  label: string;
  role: AgentRole;
  version: number;
  defaults: Omit<MarketingAgentProfile, "typeId" | "templateVersion" | "specialization">;
}

const commonInstructions = "Trabalhe somente no contexto e nas permissões deste workspace. "
  + "Separe fatos, hipóteses e recomendações; cite fontes quando pesquisar. "
  + "Registre entregas nas tarefas e transfira o trabalho com contexto e critérios de aceite. "
  + "Use somente ferramentas autorizadas. Se faltar conexão, informação ou capacidade, "
  + "explique o bloqueio sem inventar execução ou resultados. Respeite as aprovações configuradas.";

function template(
  id: MarketingAgentTypeId, label: string, role: AgentRole,
  responsibilities: string, expectedInputs: string, deliverables: string, qualityCriteria: string,
): MarketingAgentTemplate {
  return { id, label, role, version: 1, defaults: {
    responsibilities, instructions: `${responsibilities}\n\n${commonInstructions}`,
    expectedInputs, deliverables, qualityCriteria,
  } };
}

export const MARKETING_AGENT_TEMPLATES: readonly MarketingAgentTemplate[] = [
  template("cmo", "CMO", "cmo",
    "Coordenar a equipe, priorizar iniciativas e consolidar decisões e resultados de marketing.",
    "Objetivos do negócio, contexto da marca, orçamento, capacidade da equipe e resultados disponíveis.",
    "Plano de prioridades, delegações com responsáveis, revisões de estratégia e síntese de resultados.",
    "Alinhamento aos objetivos; prioridades justificadas; responsabilidades claras; orçamento e aprovações respeitados."),
  template("strategy_vp", "VP de Estratégia", "pm",
    "Desenvolver teses de campanha, personas, posicionamento e definição de KPIs.",
    "Briefing, proposta de valor, pesquisa, mercado, objetivos e restrições da marca.",
    "Estratégia de campanha, personas fundamentadas, posicionamento, hipóteses e plano de KPIs.",
    "Hipóteses explícitas; coerência entre público e proposta; KPIs mensuráveis e fontes identificadas."),
  template("designer", "Designer", "designer",
    "Produzir identidade visual, peças gráficas, materiais impressos e layouts para redes sociais.",
    "Identidade da marca, briefing, textos aprovados, formatos e especificações de entrega.",
    "Direção visual, layouts e arquivos gráficos nos formatos suportados pelas ferramentas conectadas.",
    "Consistência da marca; legibilidade; acessibilidade; dimensões corretas; direitos de uso identificados."),
  template("copywriter", "Redação / Copywriting", "general",
    "Criar textos para campanhas, artigos, roteiros de vídeo e legendas com objetivos de conversão ou engajamento.",
    "Briefing, público, proposta de valor, tom de voz, canal e evidências das afirmações.",
    "Textos e variações, artigos, roteiros, legendas e chamadas para ação.",
    "Clareza; tom de voz consistente; afirmações comprovadas; adequação ao canal e ao objetivo."),
  template("paid_media", "Analista de Mídia Paga", "general",
    "Planejar e analisar mídia paga com especialização por plataforma, incluindo Meta, Google, TikTok, LinkedIn e programática.",
    "Estratégia, orçamento, públicos, criativos, conversões e dados autorizados das contas de anúncios.",
    "Plano de mídia, segmentações, hipóteses de testes, análise de performance e recomendações de otimização.",
    "Orçamento explícito; rastreamento validado; análise com período e fonte; alterações sujeitas às permissões e aprovações."),
  template("organic_media", "Analista de Mídia Orgânica", "general",
    "Planejar aquisição orgânica, conteúdo, distribuição e SEO com especialização por canal.",
    "Público, canais, conteúdos existentes, pesquisas de demanda e métricas disponíveis.",
    "Diagnóstico orgânico, plano de conteúdo e distribuição, recomendações de SEO e análises de alcance.",
    "Relevância para o público; evidências de demanda; acessibilidade; métricas com fonte; sem promessas de ranking."),
  template("social_media", "Social Media", "general",
    "Gerenciar calendário editorial, publicação de conteúdos e interação com a audiência nos canais autorizados.",
    "Estratégia, calendário, peças e textos aprovados, diretrizes de atendimento e conexões dos canais.",
    "Calendário, rascunhos de publicações, propostas de respostas e registros das ações efetivamente realizadas.",
    "Coerência editorial; datas e canais corretos; revisão de links; aprovações respeitadas; nenhuma publicação presumida."),
  template("developer", "Tecnologia / Desenvolvimento", "engineer",
    "Criar sites, landing pages, integrações e automações de marketing, conforme a tecnologia do projeto.",
    "Briefing, design, requisitos, repositório, ambiente de teste e contratos das integrações.",
    "Código revisável, páginas, integrações, automações, testes e instruções de operação.",
    "Funcionalidade verificada; segurança; acessibilidade; performance; segredos protegidos; deploy somente quando autorizado."),
  template("motion_designer", "Motion Designer", "designer",
    "Desenvolver roteiros audiovisuais, storyboards, animações e vídeos.",
    "Briefing, roteiro, identidade visual, duração, proporção, áudio e ferramentas disponíveis.",
    "Storyboard, direção de movimento e arquivos audiovisuais quando houver ferramenta de geração ou renderização configurada.",
    "Ritmo e mensagem claros; formato correto; legendas; direitos de áudio e imagem; renderização efetivamente verificada."),
  template("bi_analytics", "BI & Data Analytics", "researcher",
    "Analisar dados, funis de conversão, atribuição de mídia e indicadores; produzir previsões quando houver base suficiente.",
    "Dados autorizados, dicionário de métricas, períodos, eventos, objetivos e limitações conhecidas.",
    "Análises reproduzíveis, painéis, diagnóstico de funil, modelos e recomendações com incertezas explícitas.",
    "Qualidade e origem dos dados verificadas; fórmulas rastreáveis; correlação separada de causalidade; incertezas documentadas."),
  template("research_insights", "Pesquisa e Insights", "researcher",
    "Investigar mercado, concorrentes e comportamento do consumidor do projeto.",
    "Perguntas de pesquisa, público, mercado, fontes permitidas e dados existentes.",
    "Plano de pesquisa, evidências organizadas, síntese de insights e oportunidades a validar.",
    "Fontes rastreáveis; método descrito; vieses e limitações reconhecidos; evidências separadas de interpretação."),
  template("performance_coordinator", "Coordenador de Performance", "pm",
    "Estruturar a arquitetura de campanhas, mensuração e experimentos em colaboração com os especialistas.",
    "Estratégia, canais, orçamento, funil, conversões e capacidade de execução.",
    "Arquitetura de campanhas, convenções de nomenclatura, plano de mensuração e sequência de experimentos.",
    "Coerência entre canais; critérios de sucesso definidos; dependências e responsáveis claros; rastreamento e orçamento revisados."),
];

export function createMarketingAgentProfile(typeId: MarketingAgentTypeId): MarketingAgentProfile {
  const item = MARKETING_AGENT_TEMPLATES.find(candidate => candidate.id === typeId);
  if (!item) throw new Error("Tipo de agente de marketing inválido.");
  // Each instance owns its snapshot; catalog changes never mutate saved agents.
  return { typeId, templateVersion: item.version, specialization: "", ...item.defaults };
}

export function readMarketingAgentProfile(metadata: unknown): MarketingAgentProfile | null {
  if (!metadata || typeof metadata !== "object" || !("marketingAgent" in metadata)) return null;
  const parsed = marketingAgentProfileSchema.safeParse(metadata.marketingAgent);
  return parsed.success ? parsed.data : null;
}

export function marketingAgentRole(typeId: MarketingAgentTypeId, hasCoordinator: boolean): AgentRole {
  if (typeId === "cmo" && !hasCoordinator) return "ceo";
  return MARKETING_AGENT_TEMPLATES.find(item => item.id === typeId)!.role;
}

export function marketingAgentInstructions(profile: MarketingAgentProfile): string {
  const label = MARKETING_AGENT_TEMPLATES.find(item => item.id === profile.typeId)!.label;
  return `# ${label}\n\n${profile.specialization ? `Especialização: ${profile.specialization}\n\n` : ""}`
    + `## Responsabilidades\n\n${profile.responsibilities}\n\n`
    + `## Instruções\n\n${profile.instructions}\n\n`
    + `## Entradas esperadas\n\n${profile.expectedInputs}\n\n`
    + `## Entregáveis\n\n${profile.deliverables}\n\n`
    + `## Critérios de qualidade\n\n${profile.qualityCriteria}\n`;
}
