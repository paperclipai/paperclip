# HEARTBEAT — Dev Full Stack

Frequência:
- Heartbeat ao iniciar trabalho e ao marcar task como concluída; resumo a cada 4h em tarefas longas.

Payload exemplo:
{"agent":"dev-fullstack","task":"T011 - cotacaoVida","status":"working|blocked|done","branch":"feat/002-omnichannel/xyz","last_commit":"sha"}

Checks:
- Executar `pnpm test` e `pnpm test:e2e` localmente antes do PR.
- Validar migrations aplicadas e docs atualizadas.
