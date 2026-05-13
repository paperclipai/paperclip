import { registerLanguage } from "@paperclipai/plugin-sdk/i18n";

const ptBrTranslations = {
  "sidebar": {
    "search": "Buscar",
    "newIssue": "Nova Tarefa",
    "dashboard": "Painel",
    "inbox": "Caixa de Entrada",
    "work": "Trabalho",
    "issues": "Tarefas",
    "routines": "Rotinas",
    "goals": "Metas",
    "workspaces": "Espaços de Trabalho",
    "projects": "Projetos",
    "agents": "Agentes",
    "company": "Empresa",
    "org": "Organização",
    "skills": "Habilidades",
    "costs": "Custos",
    "activity": "Atividade",
    "settings": "Configurações"
  },
  "common": {
    "loading": "Carregando...",
    "save": "Salvar",
    "cancel": "Cancelar",
    "delete": "Excluir",
    "edit": "Editar",
    "create": "Criar",
    "close": "Fechar",
    "confirm": "Confirmar",
    "back": "Voltar",
    "next": "Próximo",
    "yes": "Sim",
    "no": "Não",
    "search": "Buscar",
    "noResults": "Nenhum resultado encontrado",
    "error": "Algo deu errado",
    "retry": "Tentar novamente",
    "copyToClipboard": "Copiar para área de transferência",
    "copied": "Copiado!",
    "selectAll": "Selecionar tudo",
    "deselectAll": "Desmarcar tudo",
    "language": "Idioma"
  }
};

// Register the language pack as soon as the module is loaded.
if (typeof registerLanguage === "function") {
  registerLanguage(
    { code: "pt-BR", label: "Português (Brasil)", flag: "🇧🇷" },
    ptBrTranslations
  );
}

// The component itself is a null-render provider.
export function TranslationProvider() {
  return null;
}
