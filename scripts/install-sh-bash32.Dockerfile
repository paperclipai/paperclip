# Node 24 with a real bash 3.2.57 beside it, so install.sh can be exercised
# under the same shell macOS ships as /bin/bash.
#
# Building bash is the only honest option here: no maintained bash-3.2 base
# image also carries a modern Node, and BASH_COMPAT=32 does not disable bash 4+
# expansions, so it would not reproduce the failure this lane exists to catch.
#
# Notes on building 2006-era C with a current toolchain:
#   - the shipped y.tab.c was generated from an older parse.y than 3.2.57
#     actually ships and no longer matches it, so the parser must be
#     regenerated with bison rather than touched forward
#   - config.guess predates aarch64, so the build triplet is stated explicitly
#     instead of letting a 2006 script guess and fail
#   - the build-time helpers use CFLAGS_FOR_BUILD rather than CFLAGS, and gcc 14
#     turned implicit declarations into hard errors
FROM node:24-bookworm-slim

# Cross-checked against ftp.gnu.org and mirrors.kernel.org.
ARG BASH_VERSION=3.2.57
ARG BASH_SHA256=3fa9daf85ebf35068f090ce51283ddeeb3c75eb5bc70b1a4a7cb05868bfe06a4
ARG BASH32_CFLAGS="-O1 -std=gnu89 -Wno-implicit-function-declaration -Wno-return-mismatch -Wno-int-conversion -Wno-incompatible-pointer-types"

RUN set -eux; \
  apt-get update; \
  apt-get install -y --no-install-recommends build-essential bison ca-certificates curl; \
  rm -rf /var/lib/apt/lists/*; \
  cd /tmp; \
  curl --proto '=https' --tlsv1.2 -fsSL -o bash.tar.gz \
    "https://ftp.gnu.org/gnu/bash/bash-${BASH_VERSION}.tar.gz"; \
  printf '%s  bash.tar.gz\n' "$BASH_SHA256" | sha256sum -c -; \
  tar xzf bash.tar.gz; \
  cd "bash-${BASH_VERSION}"; \
  rm -f y.tab.c y.tab.h; \
  ./configure \
    --build="$(uname -m)-unknown-linux-gnu" \
    --without-bash-malloc \
    CFLAGS="$BASH32_CFLAGS"; \
  make YACC="bison -y" CFLAGS_FOR_BUILD="$BASH32_CFLAGS" -j"$(nproc)"; \
  install -m 0755 bash /usr/local/bin/bash32; \
  cd /; \
  rm -rf "/tmp/bash-${BASH_VERSION}" /tmp/bash.tar.gz; \
  apt-get purge -y build-essential bison; \
  apt-get autoremove -y; \
  bash32 --version | head -1 | grep -q 'version 3\.2\.'
