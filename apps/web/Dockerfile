FROM node:22-bookworm-slim AS dependencies

ENV PNPM_HOME=/pnpm
ENV PATH=${PNPM_HOME}:${PATH}

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json

RUN pnpm install --frozen-lockfile --filter @smart-c-playground/web...

FROM dependencies AS build

ENV NEXT_TELEMETRY_DISABLED=1

# Webアプリに必要なソースだけをビルド段階へ追加します。
COPY apps/web apps/web
COPY packages/contracts packages/contracts

RUN pnpm --filter @smart-c-playground/web build

FROM node:22-bookworm-slim AS production

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

WORKDIR /app

RUN groupadd --system --gid 1001 nodejs \
    && useradd --system --uid 1001 --gid nodejs nextjs

# standalone出力と静的アセットだけを非rootユーザーへ渡します。
COPY --from=build --chown=nextjs:nodejs /app/apps/web/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/apps/web/.next/static ./apps/web/.next/static

USER nextjs

EXPOSE 3000

CMD ["node", "apps/web/server.js"]
