# Radar web app (staging prototype). Build from the repository root:
#   docker build -f apps/web/Dockerfile .
FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV CI=true NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile && pnpm --filter @radar/web build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
COPY --from=build /app /app
USER node
WORKDIR /app/apps/web
EXPOSE 3000
CMD ["sh", "-c", "exec node_modules/.bin/next start -p ${PORT:-3000}"]
