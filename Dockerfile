# ---------------------------
# Build stage
# ---------------------------
    FROM node:22-alpine AS build

    RUN corepack enable && corepack prepare pnpm@latest --activate
    WORKDIR /app
    
    COPY pnpm-lock.yaml package.json ./
    COPY tsconfig.json ./
    RUN pnpm install --frozen-lockfile --ignore-scripts --prod=false
    
    COPY . .
    RUN pnpm run build
    RUN pnpm prune --prod
    
# ---------------------------
# Runtime (prod/default)
# ---------------------------
    FROM node:22-alpine AS runtime
    WORKDIR /app
    
    COPY --from=build --chown=node:node /app/dist ./dist
    COPY --from=build --chown=node:node /app/package.json ./package.json
    COPY --from=build --chown=node:node /app/node_modules ./node_modules
    
    ENV NODE_ENV=production
    USER node
    CMD ["node", "dist/index.js"]
    
# ---------------------------
# Runtime (local)
# ---------------------------
    FROM runtime AS local

    COPY --chown=node:node .env ./.env

    USER node
    ENTRYPOINT ["sh","-lc","[ -f ./.env ] && set -a && . ./.env && set +a; exec node dist/index.js"]
    