# syntax=docker/dockerfile:1.7
#
# Image Docker de production pour le serveur Hordes Revival.
#
# Multi-stage : un stage `build` qui installe TOUTES les dépendances et compile
# le TypeScript ; un stage `runtime` minimal qui ne contient que `dist/` + les
# dépendances de production. L'image finale tourne en utilisateur non-root.

#######################  Stage 1 : build  #######################
FROM node:20-alpine AS build
WORKDIR /app

# 1) Lockfile + manifeste d'abord pour profiter du cache Docker.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# 2) Sources, puis compilation TypeScript + recopie du schéma SQL.
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

#######################  Stage 2 : runtime  #####################
FROM node:20-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000

# Dépendances de prod uniquement (pas de tsx, vitest, typescript…).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# Code compilé.
COPY --from=build /app/dist ./dist

# Sécurité : pas de root.
RUN addgroup -S app && adduser -S app -G app && chown -R app:app /app
USER app

EXPOSE 3000

# Sonde HTTP. Render et Railway disposent de leurs propres healthchecks, mais
# pour `docker run` local + Kubernetes/Nomad on en a une intégrée.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget --quiet --spider --tries=1 http://127.0.0.1:3000/health/live || exit 1

CMD ["node", "dist/src/server/main.js"]
