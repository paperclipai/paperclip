FROM nginx:1.27-alpine

RUN apk add --no-cache openssl

COPY docker-entrypoint.d/10-generate-selfsigned-cert.sh /docker-entrypoint.d/10-generate-selfsigned-cert.sh
RUN chmod +x /docker-entrypoint.d/10-generate-selfsigned-cert.sh
