# Hordes Revival

Recréation d'un browser game multijoueur de survie inspiré de **Hordes**
([fiche Wikipédia](https://fr.wikipedia.org/wiki/Hordes_(jeu_vid%C3%A9o))).

Une ville d'humains tente de survivre face aux hordes de zombies. La partie se
joue en journées découpées en deux phases :

- **Jour** — les citoyens fouillent le désert pour rapporter des ressources et
  construisent les défenses de la ville.
- **Nuit** — la horde, dont la puissance croît chaque jour, assaille la ville.
  Les citoyens restés dans le désert sont dévorés ; si la horde déborde la
  défense, des citoyens abrités périssent.

La survie dépend aussi de l'eau : un citoyen privé d'eau perd ses forces, et
deux jours de soif sont fatals.

## Stack technique

| Couche | Choix |
|---|---|
| Langage | **TypeScript 5.7+ strict** (Node 20 LTS) |
| Serveur HTTP | **Fastify 5** + `@fastify/type-provider-typebox` |
| Temps réel | **WebSocket** via `@fastify/websocket` (libwss `ws`) |
| Rendu client | **Pixi.js 8** (canvas WebGL) + UI HTML/CSS |
| Persistance | **PostgreSQL 16** (Drizzle ORM) — source de vérité |
| Volatile | **Redis 7** (`ioredis`) — sessions, locks de nuit, pub/sub |
| Hébergement | **Fly.io** (app + Postgres) + **Upstash Redis** |
| Tests | **Vitest 2** |

Le rationnel détaillé de chaque choix (et les alternatives écartées) est dans
[docs/STACK.md](./docs/STACK.md).

## Structure du repo

```
src/
  domain/         moteur de jeu déterministe (cycle jour/nuit, citoyens,
                  ressources, résolution de nuit). Sans I/O, sans dépendance
                  serveur. Source unique de la règle métier.
  server/         couche HTTP Fastify (routes REST, validation, auth).
  realtime/       canal WebSocket : protocole partagé client/serveur, hub
                  par ville, broadcast d'événements de jeu.
  persistence/    accès Postgres (Drizzle) et Redis (ioredis), schémas,
                  migrations, locks.
  client/         frontend Pixi.js + UI HTML (introduit en M2).
  index.ts        démonstration jouable en console (M0).
tests/            suite Vitest (moteur, config serveur, protocole WS).
docs/             documentation technique (STACK.md, à venir : API, schéma BDD).
public/           landing page statique (index.html + styles + main.js).
```

## Commandes

```sh
npm install        # installe les dépendances
npm run build      # compile le TypeScript (tsc)
npm test           # lance la suite de tests (vitest)
npm run typecheck  # vérification de types sans émission
npm run demo       # joue une partie de démonstration en console
```

## Page d'accueil

La landing page est un fichier statique : ouvrir `public/index.html` dans un
navigateur. Aucune dépendance ni build requis.

## Avancement

Voir [ROADMAP.md](./ROADMAP.md). Jalon actif : **M1 — Serveur de partie & API**.
