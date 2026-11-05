# Debian slim, not alpine: better-sqlite3 ships prebuilt binaries for glibc.
FROM node:24-bookworm-slim AS base
WORKDIR /app
# Fallback for building better-sqlite3 from source if no prebuilt binary fits.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 build-essential ca-certificates \
  && rm -rf /var/lib/apt/lists/*
# The image's bundled Yarn 1, so the build doesn't download a package manager.
COPY package.json yarn.lock ./

FROM base AS deps
RUN yarn install --frozen-lockfile --production

FROM base AS build
RUN yarn install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN yarn build

FROM node:24-bookworm-slim
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
EXPOSE 3939
CMD ["node", "dist/server.js"]
