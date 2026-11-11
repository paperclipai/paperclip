# papermarketing: primeiro incremento

Data: 2026-11-09. Base: Paperclip v2026.1106.0,
`d69631b01b9c658f80bf8bed389863dce82643e1`.

## Escopo implementado

- Reutilizar `company`/`companyId` como workspace, sem segunda camada administrativa.
- Abrir um workspace com nome e contexto inicial sem contratar um agente ou
  iniciar uma tarefa automaticamente. Selecionar a equipe no cadastro seguinte.
- Exigir o tipo na criação visual de agentes e oferecer os 12 cargos acordados.
- Salvar `metadata.marketingAgent`: tipo estável, versão do modelo, especialização,
  responsabilidades, instruções, entradas, entregáveis e critérios de qualidade.
- Validar esse contrato no schema compartilhado de criação e edição. Manter
  compatibilidade com agentes upstream/importados sem perfil de marketing.
- Exigir escolha explícita entre preservar personalizações e aplicar novos
  padrões quando o cargo mudar durante o cadastro. Não substituir nome ou conta.
- Materializar o perfil revisado como instruções gerenciadas na finalização.
  Edições posteriores dos arquivos continuam no editor versionado do upstream.
- Manter contas, modelo, runtime, gestor e ferramentas nas estruturas existentes.
  O primeiro CMO usa o papel interno `ceo` para conservar a coordenação; outros
  CMOs usam `cmo`. O primeiro agente de outro tipo não vira CMO automaticamente.
- Preparar Compose autenticado com PostgreSQL e volumes separados, geração de
  segredos sem sobrescrita, healthchecks e documentação de backup/restauração.
- Acrescentar CI de verificação sem publicação de imagens ou deploy.

## Limites e próximas etapas

Este incremento inicia a implementação; não declara o plano completo entregue.
O perfil do agente usa uma extensão tipada de metadados, sem migração destrutiva.
APIs e importações legadas continuam aceitando agentes sem tipo. Convites externos
e agentes internos do sistema mantêm seus fluxos upstream. Homologar/adaptar esses
fluxos antes de tornar o catálogo obrigatório em todas as superfícies.

1. Homologar instalação limpa, primeira conta e restauração em Linux; construir e
   testar a imagem, ainda sem implantar na infraestrutura de uso.
2. Qualificar isolamento de trabalhadores por workspace. Esta composição não
   comprova isolamento entre processos e mantém runtimes locais no contêiner do app.
3. Revisar acessos entre dois workspaces em arquivos, conexões, projetos e execução.
   O código preserva a autorização upstream; testes de componentes não provam essa
   fronteira end to end.
4. Validar com contas reais OpenAI/Codex e Claude/Claude Code por assinatura,
   OpenRouter por créditos/API e, depois, Z.ai e DeepSeek. Nenhuma conta foi conectada
   neste incremento. Não prometer suporte de assinatura sem prova do método e plano.
5. Homologar Composio opcional e as permissões de ferramentas dos projetos próprios.
6. Evoluir contexto da marca, revisão de entregas e edição do perfil após criação,
   mantendo a edição versionada das instruções já disponível no upstream.
7. Completar nomenclatura e tradução nas telas herdadas. Não renomear diretórios de
   execução como se fossem novos workspaces administrativos.

Nenhuma integração com WordPress ou GA4 faz parte deste marco. Designer e Motion
Designer não ganham ferramentas de geração por receberem um cargo.

## Verificação

Verificar catálogo e validação com `marketing-agents.test.ts`; fluxo de cargo com
`MarketingAgentFields.test.tsx` e `NewAgentDialog.test.tsx`; abertura de workspace
com `WorkspaceOnboarding.test.tsx`; finalização por provedor com `NewAgent.test.tsx`.
A CI usa Linux e o lockfile da base. Não tratar um arquivo de workflow como prova
de execução: registrar os resultados observados no relatório de entrega.

No Windows deste desenvolvimento, a instalação por pnpm encontrou `EPERM` ao criar
junções. A verificação local usou dependências externas baixadas e cópias locais
dos pacotes de workspace em `node_modules`, sem alterar o lockfile. O typecheck
integral da UI nesse arranjo encontrou identidades duplicadas de Lexical e arquivos
gerados ausentes; isso permanece uma limitação de verificação local. Docker não
está instalado neste ambiente. Nenhum serviço foi implantado.

Resultados locais observados: 324 testes aprovados (17 de contrato compartilhado,
147 do cadastro de agentes/onboarding, 40 das telas de workspace e 120 das rotas
de agentes/instruções), build Vite da
UI aprovado, compilação de shared/plugin-sdk aprovada, mapas alinhados e YAML dos
arquivos Compose/CI parseado. O gerador preservou segredos numa segunda chamada.
O gate do fork não encontrou violações nos arquivos modificados; o scanner global
relatou 106 violações em arquivos upstream inalterados. A suíte integral e a imagem
Docker ainda precisam ser verificadas em instalação Linux limpa. A CI acrescentada
faz essa verificação parcial e não publica imagens nem executa deploy.

A suíte de rotas precisou de dependências compiladas e maior tempo de importação
no Windows. Um teste upstream de texto foi ajustado para aceitar LF e CRLF.
As checagens upstream de sincronização de arquivos gerados também falharam neste
checkout Windows; os arquivos correspondentes não foram modificados pelo fork.
