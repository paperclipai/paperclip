---
schema: agentcompanies/v1
name: site-goodlife
slug: site-goodlife
repo: https://github.com/corretora-goodlife/site-goodlife.git
localPath: D:\TestesIA\site-goodlife
description: >-
  Código-fonte, assets e infraestrutura do site da Corretora Goodlife. Agentes
  desta company devem usar este diretório como `working directory` quando
  forem operar sobre o código (checkout, patches, PRs, testes).
---

# Project: site-goodlife

Repositório remoto: https://github.com/corretora-goodlife/site-goodlife.git

Pasta local: D:\TestesIA\site-goodlife

Como usar

- Configure o agente `dev-fullstack` e `devops` com `Working directory` apontando
  para `D:/TestesIA/site-goodlife` (ou use path relativo conforme configuração do
  adapter).
- Para permitir que agentes abram PRs ou façam pushes automáticos, adicione um
  `GH_TOKEN` como secret na configuração da company/agent.
