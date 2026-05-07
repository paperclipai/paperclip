---
schema: agentcompanies/v1
name: Corretora Goodlife
slug: corretora-goodlife
description: >-
  Organização de agentes para manutenção, segurança e evolução do site da
  Corretora Goodlife (repositório local: D:\\TestesIA\\site-goodlife).
locale: pt-BR
---

# Corretora Goodlife

Este pacote descreve a organização de agentes criada para operar sobre o
repositório do site da Corretora Goodlife. O objetivo é automatizar tarefas de
desenvolvimento, segurança, design, entrega e operação com um conjunto de
agentes especializados.

## Workflow

Padrão: hub-and-spoke. O `CTO` coordena e delega trabalho para especialistas
(Dev Full Stack, Pentester, Designer UX-UI, QA e DevOps). Cada agente tem um
contrato de execução claro (entrada → saída → handoff) para evitar trabalhos
duplicados e garantir rastreabilidade.

## Org chart

- `cto` — reportsTo: null
- `dev-fullstack` — reportsTo: `cto`
- `pentester` — reportsTo: `cto`
- `designer-ux-ui` — reportsTo: `cto`
- `qa` — reportsTo: `cto`
- `devops` — reportsTo: `cto`

## Como usar

1. Copie ou importe este diretório para sua instância Paperclip.
2. Edite `.paperclip.yaml` se quiser habilitar variáveis de ambiente ou
   adapters específicos.
3. Ao criar/editar cada agente no painel, aponte o campo de `Working directory`
   para o caminho de trabalho desejado (por exemplo `D:/TestesIA/site-goodlife`) ou
   use bundles externos conforme necessário.

## References

Gerado para integração com o repositório local em D:\\TestesIA\\site-goodlife
e para uso com a instância Paperclip local (Conforme UI do operador).

## Projects

- `site-goodlife` — repo: https://github.com/corretora-goodlife/site-goodlife.git — local: D:\TestesIA\site-goodlife
