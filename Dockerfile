FROM node:22-alpine@sha256:8ea2348b068a9544dae7317b4f3aafcdc032df1647bb7d768a05a5cad1a7683f AS build

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.build.json ./
RUN corepack enable && corepack install
RUN pnpm install --frozen-lockfile --ignore-scripts --prod=false

COPY src ./src
RUN pnpm run build
RUN pnpm prune --prod

FROM node:22-alpine@sha256:8ea2348b068a9544dae7317b4f3aafcdc032df1647bb7d768a05a5cad1a7683f AS runtime

WORKDIR /app

ENV NODE_ENV=production

COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json

USER node

CMD ["node", "dist/index.js"]
