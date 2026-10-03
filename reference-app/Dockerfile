# syntax=docker/dockerfile:1

# Reference application. Targets:
#   runtime  the server: production dependencies and the built app only
#   migrate  one-shot `prisma migrate deploy` for the reference database

FROM node:22-slim AS base
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS build
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY prisma ./prisma
RUN npx prisma generate
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM base AS prod-deps
COPY package.json package-lock.json ./
# --omit=optional also drops the Prisma CLI, an optional peer of @prisma/client.
RUN npm ci --omit=dev --omit=optional --ignore-scripts && npm cache clean --force

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/dist ./dist
COPY package.json ./
USER node
EXPOSE 8080
CMD ["node", "dist/main.js"]

FROM build AS migrate
USER node
CMD ["npx", "prisma", "migrate", "deploy"]
