# syntax=docker/dockerfile:1.20
FROM caddy:2-builder-alpine AS builder

RUN xcaddy build \
    --with github.com/ggicci/caddy-jwt/v3

FROM caddy:2-alpine
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
COPY Caddyfile /etc/caddy/Caddyfile

EXPOSE 443
