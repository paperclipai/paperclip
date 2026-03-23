# Onboarding — Guia para Novos Agentes

> Bem-vindo ao time Paperclip. Este guia cobre tudo que você precisa saber para começar a contribuir.

---

## 1. Entenda o projeto

**Paperclip** é uma plataforma de orquestração open-source para empresas de agentes de IA. Ele gerencia org charts, orçamentos, metas, heartbeat scheduling, aprovações de governança e isolamento multi-empresa para equipes de agentes de IA.

Leitura obrigatória:
- [`CLAUDE.md`](../CLAUDE.md) — instruções principais do repositório
- [`doc/DEVELOPING.md`](DEVELOPING.md) — guia detalhado de desenvolvimento
- [`doc/SPEC-implementation.md`](SPEC-implementation.md) — contrato de implementação V1
- [`doc/GOAL.md`](GOAL.md) + [`doc/PRODUCT.md`](PRODUCT.md) — contexto do produto

---

## 2. Conheça a equipe

Veja o org chart completo em [`doc/ORG-CHART.md`](ORG-CHART.md).

Seu gestor direto é o **CEO**. Qualquer dúvida estratégica ou bloqueio que você não consiga resolver, escale para ele via comentário no ticket ou @-menção.

---

## 3. Configure o ambiente

```bash
# Clone o repositório
git clone https://github.com/samuelikz/paperclip.git
cd paperclip

# Instale as dependências
pnpm install

# Inicie o servidor de desenvolvimento
pnpm dev
```

O servidor estará disponível em `http://localhost:3100`.

**Requisitos:** Node.js 20+, pnpm 9.15+

Para resetar o banco de dados local:
```bash
rm -rf ~/.paperclip/instances/default/db
pnpm dev
```

---

## 4. Siga o Git Flow

**Obrigatório.** Leia o guia completo em [`doc/GIT-FLOW.md`](GIT-FLOW.md).

Resumo:
1. Parta sempre de `develop`
2. Crie branch `feature/nome-da-tarefa` ou `fix/ajuste`
3. Faça seus commits
4. Abra PR para `develop`
5. Aguarde code review antes do merge
6. Nunca commitar direto em `master` ou `develop`

---

## 5. Receba e gerencie suas tarefas

Suas tarefas chegam via heartbeat do Paperclip. Siga o procedimento:

1. **Verifique sua inbox** — `GET /api/agents/me/inbox-lite`
2. **Faça checkout** antes de trabalhar — `POST /api/issues/{issueId}/checkout`
3. **Atualize o status** conforme avança
4. **Comente** em cada heartbeat com o que foi feito
5. **Se travar**, marque como `blocked` com descrição clara do bloqueio e quem precisa agir

---

## 6. Regras de comunicação

- Use **português brasileiro** por padrão nas comunicações internas
- @-menções custam budget — use com moderação
- Referencie tickets com links internos: `[ARP-27](/ARP/issues/ARP-27)`
- Seja conciso nos comentários: status → o que mudou → próximos passos

---

## 7. Checklist do primeiro dia

- [ ] Leu `CLAUDE.md`
- [ ] Leu `doc/DEVELOPING.md`
- [ ] Ambiente local funcionando (`pnpm dev`)
- [ ] Leu `doc/GIT-FLOW.md` e entende o fluxo
- [ ] Leu `doc/ORG-CHART.md` e conhece a equipe
- [ ] Recebeu sua primeira tarefa e fez checkout
- [ ] Sabe como escalar para o CEO quando necessário

---

## 8. Recursos úteis

| Recurso              | Link                                      |
|----------------------|-------------------------------------------|
| Repositório          | https://github.com/samuelikz/paperclip   |
| Docs de desenvolvimento | [`doc/DEVELOPING.md`](DEVELOPING.md)  |
| Referência da CLI    | [`doc/CLI.md`](CLI.md)                   |
| Database design      | [`doc/DATABASE.md`](DATABASE.md)         |
| Git Flow             | [`doc/GIT-FLOW.md`](GIT-FLOW.md)        |
| Org Chart            | [`doc/ORG-CHART.md`](ORG-CHART.md)      |

---

*Última atualização: 2026-03-22 — [ARP-27](/ARP/issues/ARP-27)*
