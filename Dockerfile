# One image for both processes. Railway runs the API from railway.json; the worker service overrides the
# start command and runs on a cron schedule (see docs/DEPLOY_RAILWAY.md).
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build && pnpm prune --prod

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app /app
USER node
EXPOSE 8080
CMD ["node", "apps/api/dist/server.js"]
