# Preparação da CI da branch principal

Esta alteração contém somente política de CI e testes. Não incorpora a aplicação
do PR #1, não altera os lockfiles e não faz deploy.

O workflow de revisão executa a branch de base (`pull_request_target`) e a política
de lockfiles também carrega o arquivo da base. Por isso, correções somente no PR
de aplicação não conseguem resolver esses dois checks.

## Mudanças propostas

- Substituir o uso do bot privado do Paperclip por revisão de dependências e da
  descrição do PR com permissões de leitura no fork. Nenhum código do PR é
  executado nesse contexto e nenhuma credencial privada é exigida.
- Autorizar uma única migração de dependências: PR #1 do repositório
  `arthurbonora/papermarketing`, branch `feat/agent-graph-dashboard-consolidated`.
  Os três arquivos precisam corresponder aos SHA-256 registrados na política.
  O lockfile principal preserva os bytes do upstream `c8ae02e5`; a prova de
  resolução inclui a dependência XYFlow usada pelo organograma. Alterar qualquer
  byte, acrescentar um lockfile de provedor ou usar outro PR mantém o bloqueio.
  As regras normais para futuras atualizações de dependências permanecem iguais.
- Bloquear a publicação automática das imagens Docker e dos runtimes neste fork.
  Bloquear também o workflow de atualização e merge automático de lockfiles do
  upstream, cujo bot privado não foi configurado para o papermarketing.

Essa autorização restrita precisa entrar na base antes de reenviar os checks do
PR #1. Não é um resultado de testes aprovados nem uma autorização para incorporar
o PR de aplicação. O uso de contas e assinaturas dos provedores não é exercitado
por esta alteração.
