# Builds the API and worker into one image; choose the process with the command.
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
# API:    docker run ... image node apps/api/dist/server.js
# Worker: docker run ... image node apps/worker/dist/cli.js daily
CMD ["node", "apps/api/dist/server.js"]
