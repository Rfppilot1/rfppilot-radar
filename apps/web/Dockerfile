# Radar web app (staging prototype). Build from the repository root:
#   docker build -f apps/web/Dockerfile .
FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV CI=true NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
# Manifests first, so a code-only change reuses the dependency layer.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc* ./
COPY apps/web/package.json apps/web/
COPY packages/core/package.json packages/core/
RUN pnpm install --frozen-lockfile --filter @radar/web...
COPY . .
RUN pnpm --filter @radar/web build

# Runtime: only the standalone server and static assets, owned by the unprivileged user.
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
