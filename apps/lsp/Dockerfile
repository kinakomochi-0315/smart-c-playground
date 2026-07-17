FROM node:22-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN corepack enable

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/lsp/package.json apps/lsp/package.json
COPY packages/contracts/package.json packages/contracts/package.json

RUN pnpm install --frozen-lockfile --filter @smart-c/lsp...

COPY apps/lsp apps/lsp
COPY packages/contracts packages/contracts

RUN pnpm --filter @smart-c/lsp build

FROM node:22-bookworm-slim AS production

RUN apt-get update \
    && apt-get install -y --no-install-recommends bubblewrap clangd libc6-dev util-linux \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 lsp \
    && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin lsp

ENV NODE_ENV=production
ENV PORT=3001
ENV LSP_WORKSPACE_ROOT=/tmp/smart-c-lsp
ENV CLANGD_SANDBOX_PATH=/usr/bin/bwrap
ENV CLANGD_LIMITER_PATH=/usr/bin/prlimit
ENV HOME=/tmp
ENV XDG_CACHE_HOME=/tmp/.cache

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/lsp/node_modules ./apps/lsp/node_modules
COPY --from=build /app/apps/lsp/package.json ./apps/lsp/package.json
COPY --from=build /app/apps/lsp/dist ./apps/lsp/dist

USER 10001:10001
WORKDIR /app/apps/lsp

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:3001/internal/health/ready').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["node", "dist/index.js"]
