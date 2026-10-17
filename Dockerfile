# One image for both processes. Each Railway service sets its own start command (see docs/DEPLOY_RAILWAY.md).
FROM node:22-bookworm-slim AS build
WORKDIR /app
# CI=true lets pnpm reinstall without a TTY.
ENV CI=true
RUN corepack enable
COPY . .
# Build with dev dependencies, then reinstall production dependencies only. (`pnpm prune --prod` drops the
# workspace links between packages, so the runtime could not import @radar/*.)
RUN pnpm install --frozen-lockfile && pnpm build \
  && rm -rf node_modules apps/*/node_modules packages/*/node_modules \
  && pnpm install --frozen-lockfile --prod

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app /app
# The worker writes digest files under /app/data; the app itself stays read-only to the runtime user.
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 8080
CMD ["node", "apps/api/dist/server.js"]
