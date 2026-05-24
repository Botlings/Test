# `src/persistence` — Accès Postgres + Redis

Couche d'accès aux données. Aucune logique métier ici : on lit, on écrit, on
gère les transactions et les locks.

## Sous-modules (cibles M1)

- `schema.ts` — schéma Drizzle (tables `account`, `town`, `citizen`,
  `night_event`, …).
- `migrations/` — migrations SQL versionnées (générées par `drizzle-kit`).
- `db.ts` — pool Postgres + helper de transaction.
- `redis.ts` — client `ioredis` partagé.
- `locks.ts` — verrous Redis (`SET … NX EX`) pour la résolution de nuit.

## Règles d'or

- Pas de SELECT * dans le code applicatif : on déclare explicitement les
  colonnes.
- Pas d'écriture sans transaction si plusieurs tables sont touchées.
- La résolution de nuit d'une ville est protégée par un lock Redis nommé
  `town:{id}:night`.
