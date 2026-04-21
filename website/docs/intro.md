---
slug: /
sidebar_position: 1
---

# Bem-vindo à Toca da IA

A **Toca da IA** é uma plataforma self-hosted de agentes de IA para equipes — uma versão brasileira do Paperclip, otimizada para o ecossistema de negócios local.

## O que você pode fazer

- **Criar agentes** especializados para cada função da empresa
- **Automatizar tarefas** com heartbeats recorrentes
- **Integrar com Odoo, Chatwoot, Mercado Livre** e outros sistemas
- **Hospedar na sua própria infra** com total controle dos dados

## Início rápido

```bash
git clone https://github.com/connect-distribuidora/toca-da-ia.git
cd toca-da-ia
./setup.sh
```

Consulte o [Guia de Instalação](./deploy/instalacao) para instruções completas.

## Arquitetura

```
nginx (proxy reverso)
  └── app (servidor Node.js)
        ├── PostgreSQL (banco de dados)
        └── Redis (cache e filas)
```

## Próximos passos

- [Instalação completa](./deploy/instalacao)
- [API Reference](./api/overview)
- [FAQ](./faq)
