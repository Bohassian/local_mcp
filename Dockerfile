# Debian slim, not alpine: sqlite-vec's prebuilt extension targets glibc.
# No compilers or apt packages: better-sqlite3 (13+) and sqlite-vec ship their
# native binaries inside their npm packages, and Node brings its own CA store.
FROM node:24-bookworm-slim AS base
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

FROM node:24-bookworm-slim
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
EXPOSE 3939
CMD ["node", "dist/server.js"]
