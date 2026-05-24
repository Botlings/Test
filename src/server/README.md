# `src/server` — Couche HTTP (Fastify)

Endpoints REST/JSON consommés par le client. Le serveur ne contient **aucune
règle métier** : il transforme une requête HTTP en appel au moteur
(`src/domain`) puis sérialise la réponse.

## Sous-modules

- `app.ts` — fabrique l'instance Fastify, monte les plugins (CORS,
  validation, auth, WebSocket) et les routes.
- `routes/` — un fichier par feature (`auth`, `towns`, `actions`, `health`).
- `config.ts` — lecture/validation des variables d'environnement
  (`PORT`, `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, …).

## Convention

Toute route déclare son schéma d'entrée et de sortie (JSON Schema via
`@fastify/type-provider-typebox`). Une route qui mute l'état va systématiquement :

1. Vérifier l'auth (plugin `auth`).
2. Charger la ville (couche `persistence`).
3. Appeler une fonction de `src/domain` qui retourne un nouvel état.
4. Persister le résultat sous transaction Postgres.
5. Émettre les événements WS associés via `src/realtime`.
