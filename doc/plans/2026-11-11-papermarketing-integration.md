# Integração da base de marketing e da interface visual

A integração reúne a base de marketing, o grafo de agentes e o dashboard do PR #1.
Inclui o estado da branch principal em `bc453342ef4a93e3ddc7fd4bc8cf177311f5c5c6`.
Este documento descreve o comportamento e a validação exigida; não é um registro
de testes aprovados.

## Contrato do produto

- Workspace é a única divisão administrativa. As APIs e tabelas conservam o nome
  interno `company` para manter compatibilidade com o Paperclip.
- O workspace novo começa vazio. O usuário escolhe um dos 12 tipos de marketing,
  revisa responsabilidades e depois configura runtime, conta e modelo do agente.
- O cadastro fica pausado por configuração, sem heartbeat. Links diretos e a
  contratação pelo grafo passam pela mesma revisão do perfil.
- Duplicar um agente no grafo pode sugerir nome, perfil, gestor e modelo. Isso não
  copia credenciais nem ativa o novo agente.
- Cada layout pertence a um usuário e a um workspace. Agentes não podem ler,
  gravar ou remover esses layouts. Mesmo um administrador mantém seu layout
  separado dos demais usuários.
- A migração de layouts é aditiva. As rotas aparecem no contrato OpenAPI.

## Testes da interface visual

Ative `enableAgentGraph` e `enableCustomizableDashboard` nas configurações
experimentais da instância. As flags continuam desativadas por padrão durante
a homologação. Abra Equipe para o grafo e Dashboard para os widgets.

O workflow `papermarketing browser qualification` executa a suíte Playwright em
oito partições, sem provedores reais. Inclui criação de workspace vazio, seleção
obrigatória de perfil, retomada do cadastro, notas do grafo e persistência dos
widgets em workspaces diferentes.

O workflow `papermarketing qualification` executa as partições completas de
Vitest, os testes próprios do runner, suporte de E2E, build e tipos. Também
constrói a imagem Docker e inicia uma instância autenticada descartável com
PostgreSQL. O smoke test cobre limites de acesso entre usuários, agentes e dois
workspaces, além da persistência após reiniciar os contêineres.

Os workflows não publicam imagens nem fazem deploy. O stack de teste e seus
volumes são removidos ao final. O workflow de publicação herdado da branch
principal é independente; esta integração deve permanecer em uma branch de
trabalho até a autorização para publicação.

## Limites do incremento

Contas, assinaturas e modelos continuam dependentes do suporte de cada adaptador
e dos termos de cada provedor. Estes testes não comprovam login ou consumo real
de assinaturas OpenAI, Claude, Z, DeepSeek ou OpenRouter. A homologação com
projetos próprios, as conexões reais e o catálogo de integrações Composio são
etapas posteriores. WordPress permanece fora do escopo.
