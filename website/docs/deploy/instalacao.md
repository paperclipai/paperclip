---
sidebar_position: 1
---

# Guia de Instalação — Toca da IA (Self-Hosted)

Este guia cobre a instalação completa da Toca da IA em servidor próprio usando Docker Compose.

## Pré-requisitos

| Requisito | Versão mínima |
|-----------|---------------|
| Docker    | 24.x          |
| Docker Compose Plugin | 2.20+ |
| CPU       | 2 cores       |
| RAM       | 2 GB          |
| Disco     | 10 GB livres  |

## Instalação rápida (recomendado)

```bash
git clone https://github.com/connect-distribuidora/toca-da-ia.git
cd toca-da-ia
./setup.sh
```

O script `setup.sh` irá:
1. Verificar dependências (docker, curl, openssl)
2. Coletar URL pública e chaves de API
3. Gerar segredos automaticamente
4. Subir todos os serviços
5. Aguardar a aplicação ficar saudável

## Instalação manual

### 1. Clonar o repositório

```bash
git clone https://github.com/connect-distribuidora/toca-da-ia.git
cd toca-da-ia
```

### 2. Configurar variáveis de ambiente

```bash
cp .env.prod.example .env
```

Edite o `.env` e preencha os valores obrigatórios:

```env
# URL pública da sua instância
PAPERCLIP_PUBLIC_URL=https://tocadaia.exemplo.com.br

# Gere com: openssl rand -hex 32
BETTER_AUTH_SECRET=seu-segredo-aqui

# Gere com: openssl rand -hex 16
DB_PASSWORD=senha-do-banco-aqui

# Ao menos uma chave de IA é necessária
ANTHROPIC_API_KEY=sk-ant-...
# OPENAI_API_KEY=sk-...
```

### 3. Subir os serviços

```bash
docker compose -f docker/docker-compose.prod.yml --env-file .env up -d
```

Serviços iniciados:
- **db** — PostgreSQL 17 (banco de dados)
- **redis** — Redis 7 (cache e filas)
- **app** — Servidor da Toca da IA
- **nginx** — Proxy reverso (porta 80/443)

### 4. Verificar saúde

```bash
curl http://localhost/health
# {"status":"ok","version":"..."}
```

### 5. Acessar a aplicação

Abra a URL configurada em `PAPERCLIP_PUBLIC_URL` no navegador.

Na primeira vez, crie uma conta de administrador.

## Atualização

```bash
docker compose -f docker/docker-compose.prod.yml pull
docker compose -f docker/docker-compose.prod.yml up -d
```

## Configuração de domínio com HTTPS

Para HTTPS com certificado gratuito (Let's Encrypt), recomendamos usar um proxy como [Caddy](https://caddyserver.com/) ou [Traefik](https://traefik.io/) na frente do nginx.

Exemplo com Caddy (`Caddyfile`):
```
tocadaia.exemplo.com.br {
    reverse_proxy localhost:80
}
```

## Variáveis de ambiente completas

| Variável | Obrigatória | Descrição |
|----------|-------------|-----------|
| `PAPERCLIP_PUBLIC_URL` | ✅ | URL pública da instância |
| `BETTER_AUTH_SECRET` | ✅ | Segredo de autenticação (mín. 32 chars) |
| `DB_PASSWORD` | ✅ | Senha do PostgreSQL |
| `ANTHROPIC_API_KEY` | ⚠️ | API Anthropic (Claude) |
| `OPENAI_API_KEY` | ⚠️ | API OpenAI |
| `APP_IMAGE` | ❌ | Imagem Docker (padrão: ghcr.io/...) |
| `HTTP_PORT` | ❌ | Porta HTTP do nginx (padrão: 80) |
| `HTTPS_PORT` | ❌ | Porta HTTPS do nginx (padrão: 443) |

⚠️ = ao menos uma das chaves de IA é obrigatória para agentes funcionarem.

## Troubleshooting

### App não sobe

```bash
docker compose -f docker/docker-compose.prod.yml logs app
```

### Banco inacessível

```bash
docker compose -f docker/docker-compose.prod.yml logs db
docker compose -f docker/docker-compose.prod.yml exec db pg_isready -U paperclip
```

### Reiniciar um serviço

```bash
docker compose -f docker/docker-compose.prod.yml restart app
```

## Próximos passos

- [Backup e Restore](./backup-restore.md)
- [Health Check e Monitoramento](./health-monitoring.md)
