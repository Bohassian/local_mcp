# Debian slim, not alpine: sqlite-vec's prebuilt extension targets glibc.
# No compilers or apt packages: better-sqlite3 (13+) and sqlite-vec ship their
# native binaries inside their npm packages, and Node brings its own CA store.
FROM node:24-bookworm-slim AS base
WORKDIR /app
# The image's bundled Yarn 1, so the build doesn't download a package manager.
# .yarnrc turns off dependency install scripts (see the file).
COPY package.json yarn.lock .yarnrc ./

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
