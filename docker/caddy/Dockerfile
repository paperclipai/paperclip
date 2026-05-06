# syntax=docker/dockerfile:1.20
FROM caddy:2-builder-alpine AS builder

RUN xcaddy build \
    --with github.com/ggicci/caddy-jwt

FROM caddy:2-alpine
COPY --from=builder /usr/bin/caddy /usr/bin/caddy

# Caddyfile is inlined so the image builds correctly regardless of whether
# Railway uses the repo root or docker/caddy/ as the build context.
RUN printf '%s\n' \
    '{' \
    '	email {$ACME_EMAIL}' \
    '	log {' \
    '		output stdout' \
    '		format json' \
    '		level INFO' \
    '	}' \
    '	order jwtauth before reverse_proxy' \
    '}' \
    '' \
    'app.ops.binelek.io {' \
    '	jwtauth {' \
    '		sign_key       {$SESSION_JWT_SECRET}' \
    '		sign_alg       HS256' \
    '		from_cookies   jaban_session' \
    '		issuer_allow   ops-portal-vercel' \
    '		audience_allow paperclip-ops-caddy' \
    '		user_claims    email sub' \
    '	}' \
    '' \
    '	handle_errors 401 {' \
    '		redir https://ops.binelek.io/login 302' \
    '	}' \
    '' \
    '	@websocket {' \
    '		header Connection *Upgrade*' \
    '		header Upgrade    websocket' \
    '	}' \
    '	reverse_proxy @websocket {$PAPERCLIP_UPSTREAM} {' \
    '		header_up Host              {host}' \
    '		header_up X-Real-IP         {remote_host}' \
    '		header_up X-Forwarded-For   {remote_host}' \
    '		header_up X-Forwarded-Proto https' \
    '	}' \
    '' \
    '	reverse_proxy {$PAPERCLIP_UPSTREAM} {' \
    '		header_up Host                 {host}' \
    '		header_up X-Real-IP            {remote_host}' \
    '		header_up X-Forwarded-For      {remote_host}' \
    '		header_up X-Forwarded-Proto    https' \
    '		header_up X-Authenticated-User {http.auth.user.email}' \
    '	}' \
    '}' \
    > /etc/caddy/Caddyfile

EXPOSE 443
