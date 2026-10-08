FROM node:22-slim AS build
RUN corepack enable
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/worker/package.json packages/worker/
COPY packages/operator/package.json packages/operator/
COPY packages/explorer/package.json packages/explorer/
RUN pnpm install --frozen-lockfile
COPY packages ./packages
RUN pnpm --filter @arckive/core --filter @arckive/worker --filter @arckive/operator build \
  && pnpm --filter @arckive/worker deploy --legacy --prod /out/worker \
  && pnpm --filter @arckive/operator deploy --legacy --prod /out/operator

# The explorer builds in a stage of its own, so a worker or operator image
# never waits on `next build` (BuildKit skips stages a target does not need).
FROM build AS explorer-build
RUN pnpm --filter @arckive/explorer build

FROM node:22-slim AS worker
WORKDIR /app
COPY --from=build /out/worker .
USER node
ENV NODE_ENV=production
CMD ["node", "dist/main.js"]

FROM node:22-slim AS operator
WORKDIR /app
COPY --from=build /out/operator .
USER node
ENV NODE_ENV=production
CMD ["node", "dist/main.js"]

# next build's standalone output: server.js and only the files it traced.
FROM node:22-slim AS explorer
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
COPY --from=explorer-build /app/packages/explorer/.next/standalone ./
COPY --from=explorer-build /app/packages/explorer/.next/static ./packages/explorer/.next/static
USER node
EXPOSE 3000
CMD ["node", "packages/explorer/server.js"]
