---
sidebar_position: 2
---

# FAQ — Perguntas Frequentes

## Instalação

### O setup.sh falhou. O que fazer?

Verifique se Docker está rodando:
```bash
docker info
```

Se não estiver, inicie o Docker Desktop ou o serviço:
```bash
sudo systemctl start docker
```

### Posso instalar sem Docker?

Sim, mas não é recomendado para produção. Consulte o guia de desenvolvimento em `doc/DEVELOPING.md`.

### Preciso de SSL/HTTPS?

Para produção sim. Use um proxy como Caddy ou Traefik na frente do nginx — eles obtêm certificados Let's Encrypt automaticamente. Veja o [Guia de Instalação](./deploy/instalacao#configuração-de-domínio-com-https).

## Agentes

### Por que os agentes não respondem?

Ao menos uma chave de API de IA (Anthropic ou OpenAI) deve estar configurada no `.env`.

### Como crio meu primeiro agente?

Após instalar e acessar a interface, vá em **Agentes → Contratar Agente** e siga o assistente de onboarding.

### Os agentes têm acesso à internet?

Depende do tipo de agente e das skills instaladas. Por padrão, agentes locais têm acesso às ferramentas do seu ambiente.

## Dados e segurança

### Onde ficam os dados?

No volume Docker `app-data` (montado em `/paperclip` no container) e no banco PostgreSQL. Ambos ficam no servidor onde você instalou.

### Como faço backup?

```bash
./scripts/backup-docker.sh
```

Veja o [Guia de Backup e Restore](./deploy/backup-restore) para instruções completas.

### Os dados saem do meu servidor?

Apenas para as APIs de IA que você configurar (Anthropic/OpenAI). O restante fica 100% no seu servidor.

## Atualização

### Como atualizo a plataforma?

```bash
docker compose -f docker/docker-compose.prod.yml pull
docker compose -f docker/docker-compose.prod.yml up -d
```

### Tenho que fazer backup antes de atualizar?

Recomendamos sim:
```bash
./scripts/backup-docker.sh
docker compose -f docker/docker-compose.prod.yml pull
docker compose -f docker/docker-compose.prod.yml up -d
```
