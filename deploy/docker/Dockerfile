# syntax=docker/dockerfile:1
# The Nether server, with the web app it serves (ADR 0054). Built from the
# repository's root:
#
#   docker build -f deploy/docker/Dockerfile -t nether-server .
#
# The JavaScript is built once, on the builder's own platform; only the
# server's production dependencies are installed for each platform the
# image is for, so an arm64 image builds quickly on an amd64 machine.
# Node.js stays on 24, as .nvmrc has it; Dependabot moves the three FROM
# lines together.

# The web app and the server, built from the whole workspace.
FROM --platform=$BUILDPLATFORM node:24.22.3-alpine AS build
ENV CI=true
RUN corepack enable
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY tools/stubs/elkjs/ tools/stubs/elkjs/
# The packages the lockfile names, in a layer kept while it stays the
# same. Not in a cache mount: a CI cache restores this layer and not the
# mount, which the offline install would then miss.
RUN pnpm fetch
COPY . .
RUN pnpm install --offline --frozen-lockfile --ignore-scripts
RUN pnpm --filter @nether/web build && pnpm --filter @nether/server build

# The server's dependencies alone, without the tools that build it. The
# workspace's own packages stay folders beside it, as in the repository:
# Node strips their types, which it does only outside node_modules.
FROM node:24.22.3-alpine AS dependencies
ENV CI=true
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY tools/stubs/elkjs/ tools/stubs/elkjs/
COPY apps/server/package.json apps/server/
# The workspace packages the server runs: @nether/search, the editor's
# document code with @nether/core and @nether/markdown for the public API
# (ADR 0059), @nether/ai's paths and headers for the AI relay (ADR 0070),
# and @nether/storage's link reading for published sites (ADR 0076).
COPY packages/ai/package.json packages/ai/
COPY packages/core/package.json packages/core/
COPY packages/editor/package.json packages/editor/
COPY packages/markdown/package.json packages/markdown/
COPY packages/search/package.json packages/search/
COPY packages/storage/package.json packages/storage/
# The image's entry, which starts the server with every enterprise
# feature's module, each off until an admin switches it on (ADR 0079).
COPY enterprise/server/package.json enterprise/server/
COPY enterprise/admin/package.json enterprise/admin/
COPY enterprise/sso/package.json enterprise/sso/
COPY enterprise/policies/package.json enterprise/policies/
COPY enterprise/audit/package.json enterprise/audit/
COPY enterprise/ha/package.json enterprise/ha/
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --prod --frozen-lockfile --ignore-scripts --filter "@nether/enterprise-server..."

FROM node:24.22.3-alpine
LABEL org.opencontainers.image.title="Nether server" \
      org.opencontainers.image.description="The Nether server: sync, sharing and the web app, on a server you control." \
      org.opencontainers.image.source="https://github.com/fzn0x/nether" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later"
ENV NODE_ENV=production \
    NETHER_HOST=0.0.0.0 \
    NETHER_PORT=3000 \
    NETHER_STORAGE_PATH=/data/attachments \
    NETHER_BACKUP_PATH=/data/backups
WORKDIR /app
COPY --from=dependencies /app/ ./
COPY --from=build /src/packages/ai/src/ packages/ai/src/
COPY --from=build /src/packages/core/src/ packages/core/src/
COPY --from=build /src/packages/editor/src/ packages/editor/src/
COPY --from=build /src/packages/markdown/src/ packages/markdown/src/
COPY --from=build /src/packages/search/src/ packages/search/src/
COPY --from=build /src/packages/storage/src/ packages/storage/src/
COPY --from=build /src/apps/server/dist/ apps/server/dist/
# The entry imports the server's source, whose types Node strips, as it
# does the workspace's packages'; dist/ stays for the admin's commands.
COPY --from=build /src/apps/server/src/ apps/server/src/
COPY --from=build /src/enterprise/server/src/ enterprise/server/src/
COPY --from=build /src/enterprise/admin/src/ enterprise/admin/src/
COPY --from=build /src/enterprise/sso/src/ enterprise/sso/src/
COPY --from=build /src/enterprise/policies/src/ enterprise/policies/src/
COPY --from=build /src/enterprise/audit/src/ enterprise/audit/src/
COPY --from=build /src/enterprise/ha/src/ enterprise/ha/src/
COPY --from=build /src/apps/web/dist/ apps/web/dist/
COPY LICENSE ./
# A new named volume starts with these folders, owned by the server's user.
RUN mkdir -p /data/attachments /data/backups && chown -R node:node /data
USER node
VOLUME /data
EXPOSE 3000
WORKDIR /app/apps/server
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.NETHER_PORT}/health`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "../../enterprise/server/src/main.ts"]
