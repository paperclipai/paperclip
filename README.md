# Brabrix Agent

Plataforma agentic para times de engenharia que querem transformar backlog em entrega real com IA, mantendo controle do contexto, observabilidade e execução local no repositório.

![Status](https://img.shields.io/badge/status-active%20development-0f766e)
![Fork](https://img.shields.io/badge/fork-paperclipai%2Fpaperclip-1d4ed8)
![License](https://img.shields.io/badge/license-MIT-blue)
![Node](https://img.shields.io/badge/node-%3E%3D20-16a34a)
![pnpm](https://img.shields.io/badge/pnpm-%3E%3D9-f97316)

> [!IMPORTANT]
> Este projeto é um fork do [Paperclip](https://github.com/paperclipai/paperclip), preserva a licença MIT e os créditos originais. O foco da Brabrix é evoluir a base para fluxos de engenharia assistida por IA no ecossistema Brabrix Dev, com mudanças incrementais e compatíveis com o upstream sempre que possível.

## Visão comercial

O Brabrix Agent foi criado para squads que precisam de velocidade com governança.

Com ele, sua equipe consegue:

- reduzir tempo entre planejamento e execução técnica
- transformar tarefas em contexto acionável para agentes
- padronizar entregas com specs técnicas estruturadas
- manter rastreabilidade com logs, timeline e histórico de alterações

## Novidade: Gerador de Spec Técnica por Issue

Agora cada issue pode deixar de ser só uma tarefa curta e virar uma especificação técnica completa, com um clique.

Na tela de detalhe da issue, a ação **Gerar spec técnica** permite:

- gerar conteúdo estruturado por IA com base no contexto da issue
- respeitar o idioma selecionado (`pt-BR` e `en`)
- visualizar a spec em seção separada (sem sobrescrever a descrição original)
- copiar, editar, salvar, regenerar e cancelar geração
- persistir como documento técnico da issue (`technical-spec`)

Estrutura gerada inclui:

- resumo
- contexto
- objetivo técnico
- regras de negócio
- escopo incluído e fora de escopo
- impactos técnicos
- APIs/contratos
- modelo de dados
- critérios de aceite
- plano de testes
- riscos
- checklist de implementação
- sugestão de subtasks

## Principais funcionalidades

Legenda:

- `✅` disponível
- `🧪` em evolução
- `🗺️` roadmap

| Funcionalidade | Status | Observação |
| --- | --- | --- |
| Agentes locais | ✅ | Adapters como `claude_local`, `codex_local`, `gemini_local`, `opencode_local` e outros |
| Execução orientada por goals/issues | ✅ | Fluxo de trabalho conectado ao projeto local |
| Import Brabrix Project | ✅ | Importa contexto, PRD, specs, backlog, goals e skills |
| Sincronização com Brabrix Dev | ✅ | Sincroniza tarefas/issues e contexto do projeto |
| Brabrix SkillHub provider | ✅ | Busca, categorias, destaque e importação de skills públicas |
| Gerador de Spec Técnica por Issue | ✅ | Geração estruturada por IA com edição/salvamento na issue |
| Suporte a múltiplos idiomas | ✅ | i18n com `pt-BR` e `en` |
| Logs e timeline operacional | ✅ | Observabilidade da execução e diagnóstico |
| Diff preview e workflows avançados | 🧪 | Melhorias contínuas de revisão e automação |
| Multi-agent orchestration avançada | 🗺️ | Evolução planejada do runtime |

## Como a plataforma funciona

```text
Brabrix Dev
  ↓
Projetos / PRD / Specs / Backlog / Skills
  ↓
Brabrix Agent
  ↓
Execução local no repositório
  ↓
Logs / Timeline / Resultados
```

```mermaid
flowchart TD
  A[Brabrix Dev] --> B[Projetos / PRD / Specs / Backlog / Skills]
  B --> C[Brabrix Agent]
  C --> D[Execução local no repositório]
  D --> E[Logs / Timeline / Resultados]
```

## Diferenciais em relação ao Paperclip original

- integração nativa com Brabrix Dev
- fluxo de importação e sincronização de projeto completo
- provider adicional de skills: Brabrix SkillHub
- foco em engenharia de software (contexto, backlog, spec e execução)
- experiência em português (pt-BR) sem perder suporte global em inglês

## Subir local (modo fácil com `.sh`)

### 1) Clonar e entrar no projeto

```bash
git clone <url-do-seu-fork>
cd brabrix-agent
```

### 2) Instalar dependências

```bash
pnpm install
```

### 3) Subir o Brabrix Agent local

```bash
./scripts/brabrix-up.sh
```

Esse script:

- cria `.env` com defaults locais, se ainda não existir
- prepara o worktree do Paperclip (`.paperclip/`)
- sobe o servidor de desenvolvimento

URL esperada: `http://127.0.0.1:3101` (ou a próxima porta livre).

### 4) Parar a aplicação local

```bash
./scripts/kill-dev.sh
```

Para apenas visualizar o que seria encerrado:

```bash
./scripts/kill-dev.sh --dry
```

### 5) Gerar build local

```bash
./build.sh
```

## Subir em produção

### Opção 1: Compose quickstart (mais simples)

```bash
BETTER_AUTH_SECRET=$(openssl rand -hex 32) \
docker compose -f docker/docker-compose.quickstart.yml up --build -d
```

Parar:

```bash
docker compose -f docker/docker-compose.quickstart.yml down
```

### Opção 2: Compose completo com PostgreSQL

```bash
BETTER_AUTH_SECRET=$(openssl rand -hex 32) \
docker compose -f docker/docker-compose.yml up --build -d
```

Parar:

```bash
docker compose -f docker/docker-compose.yml down
```

Se quiser remover também os volumes/dados do ambiente Docker:

```bash
docker compose -f docker/docker-compose.yml down -v
```

## Configuração essencial

Exemplo mínimo de variáveis em `.env`:

```env
DATABASE_URL=postgres://paperclip:paperclip@localhost:5432/paperclip
PORT=3100
PAPERCLIP_PUBLIC_APP_NAME=Brabrix Agent
VITE_PUBLIC_APP_NAME=Brabrix Agent

BRABRIX_API_URL=https://api.brabrix.com
BRABRIX_AGENT_TOKEN=
BRABRIX_PROJECT_ID=
BRABRIX_TENANT_ID=

BRABRIX_SKILLHUB_ENABLED=true
BRABRIX_SKILLHUB_API_URL=https://api.brabrix.com
```

Observações importantes:

- a API key/token do Brabrix pode ser configurada por empresa em **Company Settings → Brabrix** (modelo recomendado para cloud)
- o runtime mantém fallback para variáveis de ambiente legadas, quando necessário
- endpoints de Brabrix e SkillHub já possuem defaults para produção e podem ser sobrescritos por ambiente

## Providers de skills

- GitHub
- `skills.sh`
- Brabrix SkillHub

Para detalhes, veja [ROADMAP.md](ROADMAP.md).

## Contribuição

Contribuições são bem-vindas.

Fluxo recomendado:

1. abra uma issue com contexto claro
2. implemente em branch pequena e revisável
3. preserve compatibilidade com upstream sempre que possível
4. rode validações locais (`pnpm test`, `typecheck`, build no escopo alterado)
5. abra PR com trade-offs e plano de rollback quando aplicável

Guia completo: [CONTRIBUTING.md](CONTRIBUTING.md)

## Licença

Este projeto está sob licença MIT.

- Fork base: [paperclipai/paperclip](https://github.com/paperclipai/paperclip)
- Licença do fork: [LICENSE](LICENSE)
- Licença do upstream: [LICENSE upstream](https://github.com/paperclipai/paperclip/blob/master/LICENSE)
