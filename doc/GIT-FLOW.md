# Git Flow — Guia Prático

> Definido em [ARP-22](/ARP/issues/ARP-22) e [ARP-23](/ARP/issues/ARP-23). Obrigatório para todos os agentes e colaboradores.

## Regra de ouro

**Nunca commitar diretamente em `master` ou `develop`.**

Todo trabalho começa em uma branch própria e entra via Pull Request.

---

## Fluxo passo a passo

### 1. Parta sempre de `develop`

```bash
git checkout develop
git pull origin develop
```

### 2. Crie sua branch

| Tipo         | Convenção                    | Exemplo                          |
|--------------|------------------------------|----------------------------------|
| Nova feature | `feature/nome-da-tarefa`     | `feature/arp-27-docs-audit`      |
| Correção     | `fix/descricao-do-ajuste`    | `fix/readme-broken-link`         |
| Docs         | `docs/o-que-foi-documentado` | `docs/git-flow-guide`            |
| Chore/Infra  | `chore/descricao`            | `chore/update-dependencies`      |

```bash
git checkout -b feature/nome-da-tarefa
```

### 3. Faça seus commits

- Commits atômicos e descritivos
- Inclua `Co-Authored-By: Paperclip <noreply@paperclip.ing>` se for um commit de agente

```bash
git add <arquivos>
git commit -m "feat: descrição clara do que foi feito

Co-Authored-By: Paperclip <noreply@paperclip.ing>"
```

### 4. Suba a branch e abra o PR

```bash
git push origin feature/nome-da-tarefa
```

Abra o Pull Request apontando para **`develop`** (nunca para `master`).

O PR deve incluir:
- Título descritivo
- O que foi feito e por quê
- Referência à tarefa do board (ex: `ARP-27`)

### 5. Code Review

Todo PR deve ser revisado e aprovado antes do merge. Objetivo: compartilhar conhecimento e evitar dívida técnica.

### 6. Merge

Após aprovação, faça o merge para `develop`. Merges de `develop` para `master` acontecem em releases planejadas.

---

## Diagrama do fluxo

```
master ──────────────────────────────────────────── (produção estável)
          │                                   ↑
          └──→ develop ──────────────────────── (integração)
                    │                    ↑
                    └──→ feature/xxx ────
                    └──→ fix/yyy ────────
```

---

## Perguntas frequentes

**Posso commitar direto em `develop`?**
Não. Todo trabalho, mesmo pequeno, deve passar por uma branch e PR.

**E se minha task for urgente?**
Mesmo tarefas críticas seguem o fluxo. Crie a branch, abra o PR, peça revisão rápida.

**Quem faz o merge?**
Qualquer membro com acesso pode fazer o merge após aprovação. O autor não deve aprovar o próprio PR.

---

*Última atualização: 2026-03-22 — [ARP-27](/ARP/issues/ARP-27)*
