# Debian slim, not alpine: sqlite-vec's prebuilt extension targets glibc.
# Pinned by version and digest (multi-arch index), so a rebuild can't pull a
# different Node or Debian packages. Dependabot proposes updates; keep the Node
# version in step with ci.yml. Both FROM lines must match.
# No compilers or apt packages: better-sqlite3 (13+) and sqlite-vec ship their
# native binaries inside their npm packages, and Node brings its own CA store.
FROM node:24.22.2-trixie-slim@sha256:0820eaa85e07d0490446dd01d14707e17e6108a36988cf374899cd057eb3812d AS base
WORKDIR /app
# The image's bundled npm, so the build doesn't download a package manager.
# `npm ci` installs exactly package-lock.json; .npmrc turns off dependency
# install scripts (see the file).
COPY package.json package-lock.json .npmrc ./

FROM base AS deps
RUN npm ci --omit=dev

FROM base AS build
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24.22.2-trixie-slim@sha256:0820eaa85e07d0490446dd01d14707e17e6108a36988cf374899cd057eb3812d
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
EXPOSE 3939
CMD ["node", "dist/server.js"]
