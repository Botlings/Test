# Stack technique — Hordes Revival

Document de référence de la stack retenue pour reconstruire Hordes en browser
game multijoueur. Chaque section : (1) la décision, (2) le pourquoi, (3) les
alternatives écartées, (4) la consigne d'application.

---

## 0. Langage et runtime — Node.js + TypeScript strict

**Décision.** Tout le code, serveur et client, est écrit en **TypeScript
strict** et exécuté sous **Node.js LTS ≥ 20** côté serveur. Le moteur de jeu
(`src/domain/`) est déjà en TS pur, déterministe, sans I/O.

**Pourquoi.** Un seul langage côté serveur et côté client réduit la friction
d'itération sur un jeu où le même modèle (citoyens, ressources, nuit) doit
être manipulé des deux côtés. TS strict + `noUncheckedIndexedAccess` attrape
en amont les bugs de typage critiques pour un jeu permadeath.

**Écartés.** PHP (langage du Hordes original) : moins ergonomique pour
partager du code de domaine avec le client. Go/Rust : excellents mais
sur-dimensionnés pour la cible de charge prévue.

**Consigne.** Aucun `any` implicite. Le moteur reste sans I/O. Les nouveaux
modules serveur exposent des fonctions pures dès que possible.

---

## 1. Rendu client — Pixi.js (canvas WebGL) + UI HTML

**Décision.** Le **canvas de la carte du désert et de la ville** est rendu
avec **[Pixi.js v8](https://pixijs.com/)**. Les écrans périphériques (menus,
chantiers, banque, fiches citoyens, chat) sont du **HTML/CSS** classique
piloté par **un framework UI léger côté client** (à arbitrer entre Solid.js et
Svelte au début du M2 — par défaut Solid.js, plus proche de React pour les
contributeurs).

**Pourquoi.** Hordes est un jeu **tour par tour à l'échelle d'une journée**,
PAS un jeu d'action temps réel. Le besoin graphique est :
- afficher une grille de cases du désert (≈ 13×13) avec tuiles + tokens ;
- afficher la ville en vue isométrique légère (chantiers, défenses) ;
- pas d'animation 60 FPS, pas de physique, pas de skeletal animation.

Pixi.js fournit exactement ce qu'il faut : un renderer canvas/WebGL
performant, un graphe de scène simple, des sprites et du texte. Léger
(~100 KB gzipped en v8), mainteneurs actifs, écosystème stable depuis 2013.

**Écarté — Phaser 3.** Phaser embarque un moteur de jeu complet (physique
Arcade/Matter, gestion de scènes, input gamepad, tweens audio, etc.) inutile
pour un jeu tour par tour. Surface API plus grosse, plus dépendant d'une
"manière de faire". Bundle ~700 KB. On l'aurait choisi pour un action-RPG ou
un platformer, pas pour Hordes.

**Écarté — DOM + CSS pur.** Possible (le Hordes original l'a fait), mais le
rendu de la carte du désert avec déplacement et icônes devient pénible et
peu performant en DOM dès qu'il y a beaucoup de tokens (citoyens, objets,
zombies au sol).

**Consigne d'application.**
- Le rendu Pixi vit dans `src/client/render/`.
- Le canvas reçoit l'état de jeu en lecture seule (snapshot sérialisé du
  domaine) ; il ne mute jamais le modèle.
- Les interactions utilisateur produisent des **actions** envoyées au serveur
  via WebSocket ; le client n'applique pas la règle métier — il l'affiche.

---

## 2. Transport temps réel — Fastify + WebSocket natif (`ws`)

**Décision.** Le serveur de partie est un service **Fastify** unique qui
expose :
- une **API HTTP REST/JSON** pour les opérations idempotentes (créer un
  compte, créer une ville, lister les villes, consulter un état) ;
- un **endpoint WebSocket** (`/ws`) via [`@fastify/websocket`](https://github.com/fastify/fastify-websocket)
  (qui s'appuie sur `ws`) pour le canal temps réel ville ↔ joueurs (push
  d'événements : arrivée d'un citoyen, chantier complété, début/fin de nuit,
  message de chat).

**Pourquoi.**
- Fastify : routeur HTTP rapide, typesafe (intégration TS first-class via
  `@fastify/type-provider-typebox`), schema-driven (validation entrée/sortie
  par JSON Schema), écosystème de plugins matures (auth, rate-limit, CORS,
  WebSocket).
- `ws` (via le plugin Fastify) : implémentation WebSocket de référence en
  Node, dépendance directe de tout l'écosystème Node temps réel.

**Écarté — Socket.IO.** Apporte du fallback long-polling et du routing
"room" que Hordes n'a pas besoin (un joueur = une ville = un canal). On
préfère le protocole WebSocket natif, payload JSON contrôlée côté serveur.
On reconsidérera si on a un jour besoin de cluster multi-noeud avec adapter
Redis prêt à l'emploi.

**Écarté — SSE (Server-Sent Events).** Suffisant pour le push descendant,
mais ne couvre pas le canal montant (chat, actions). Nécessiterait un second
canal HTTP : doublon, latence accrue, deux protocoles à monitorer.

**Consigne d'application.**
- L'API HTTP vit dans `src/server/http/` (Fastify routes par feature).
- Le canal WebSocket vit dans `src/realtime/`.
- Tout message WS est typé : un discriminé `{ type: 'night.start' | … }`
  défini dans `src/realtime/protocol.ts`, partagé entre serveur et client.
- Le serveur est la source de vérité — toute action client passe par un
  appel REST ; le WS sert au **push** d'événements.

---

## 3. Persistance — PostgreSQL (source de vérité) + Redis (volatile)

**Décision.** Architecture à deux étages :

| Étage | Techno | Rôle |
|---|---|---|
| Source de vérité | **PostgreSQL 16** | Comptes joueurs, villes, parties, citoyens, événements de nuit, historique permadeath, classement. |
| Volatile / temps réel | **Redis 7** | Sessions, locks de partie (résolution de nuit atomique), pub/sub WebSocket si scale-out, files d'attente de tâches. |

Accès Postgres via [**Drizzle ORM**](https://orm.drizzle.team/) (typesafe,
ESM-first, migrations versionnées en SQL). Accès Redis via
[**ioredis**](https://github.com/redis/ioredis).

**Pourquoi PostgreSQL.**
- Modèle relationnel pertinent : `town → citizens → actions/events`, contraintes
  d'intégrité fortes (un citoyen mort ne peut plus agir, une partie close ne
  reçoit plus d'événement), agrégations pour le classement.
- Permadeath et historique → on veut un journal d'événements indexable
  (`SELECT * FROM night_event WHERE town_id = ? ORDER BY day`).
- Postgres a JSONB si on a besoin de souplesse (snapshots d'état),
  transactions sérialisables, replication standard chez tous les hébergeurs.

**Pourquoi Redis.**
- Le **lock de résolution de nuit** doit être atomique au niveau cluster :
  Redis `SET … NX EX` est le standard.
- Sessions et rate-limit : Redis évite d'aller taper Postgres pour chaque
  requête HTTP.
- Pub/sub pour fan-out WS si l'app passe sur plusieurs nœuds Fastify (post-MVP).

**Écarté — Redis seul.** Pas de garantie de durabilité forte, pas de
relationnel propre. Inadapté à des données qu'on doit conserver sur des mois
(historique des villes, classement).

**Écarté — Postgres seul.** Possible techniquement (advisory locks pour les
locks de nuit), mais on perd la souplesse pub/sub et on charge inutilement
la base sur les opérations volatiles.

**Écarté — SQLite.** OK pour le dev local, mais le multijoueur en
production demande un serveur à écritures concurrentes propres.

**Consigne d'application.**
- Schéma SQL dans `src/persistence/schema.ts` (Drizzle), migrations dans
  `src/persistence/migrations/`.
- Aucune logique métier dans la couche persistance : elle lit / écrit, c'est
  tout. Les règles vivent dans `src/domain/`.
- Toute écriture importante (résolution de nuit) doit passer dans une
  transaction Postgres encadrée par un lock Redis.

---

## 4. Auth — JWT court + refresh + httpOnly cookie

**Décision.** Authentification par **email + mot de passe** (Argon2id pour le
hash). Le serveur émet un **access token JWT** de 15 min et un **refresh
token** opaque stocké en cookie `httpOnly` `Secure` `SameSite=Strict`,
révocable via Redis.

**Pourquoi.** Standard, bien outillé, suffisant pour un browser game
coopératif. Pas d'OAuth en M1 pour éviter le couplage à un IdP externe.

**Consigne.** Aucun token en `localStorage` (XSS). Argon2id paramétré sur les
recommandations OWASP en vigueur.

---

## 5. Hébergement — Fly.io (app + Postgres + Redis managés)

**Décision.** L'application est déployée sur **[Fly.io](https://fly.io/)** :
- l'app Node Fastify tourne en machines `fly machines` (1 région primaire,
  scale-out horizontal si besoin) ;
- la base est **Fly Postgres** (Postgres managé, snapshots quotidiens, point-in-time
  recovery) ;
- Redis via **Upstash Redis** (free tier jusqu'à 10 000 commandes/jour,
  payant ensuite) ou **Fly Redis** (basé sur Upstash).

**Domaine et CDN.** Le DNS du domaine `hordes-revival.example` (à acheter)
pointe sur Fly. Les assets statiques (sprites Pixi, polices, build client)
sont servis via **Cloudflare** en cache devant Fly.

**Pourquoi.**
- Fly déploie un binaire Docker près de l'utilisateur, démarrage rapide,
  pricing prévisible. Bon support WebSocket (connexions longues).
- Postgres managé évite de gérer backup/restore à la main pendant qu'on est
  encore deux contributeurs.
- Pas de vendor lock : tout est du Docker + du Postgres standard, migrable
  vers Render, Railway, Hetzner si besoin.

**Écarté — Vercel.** Excellent pour du front + edge functions, mais le modèle
serverless pénalise les connexions WebSocket longues et le besoin d'un
serveur de partie persistant.

**Écarté — VPS auto-hébergé (Hetzner / OVH).** Moins cher au volume, mais
demande de l'ops (backup Postgres, monitoring, TLS) qu'on n'a pas envie de
payer en temps humain au stade actuel.

**Écarté — AWS.** Sur-dimensionné, coûts difficiles à prévoir, IAM coûteux
en temps. On y reviendra si on dépasse 10 000 joueurs actifs.

**Consigne.**
- Le `Dockerfile` à la racine doit produire une image lançable sans variable
  d'env locale (toutes les configs viennent de l'environnement Fly).
- Aucune ressource Fly n'est créée hors `fly.toml` — pas d'état dans la
  console.

---

## 6. CI / qualité — GitHub Actions + lint + tests + types

**Décision.** Pipeline GitHub Actions sur chaque PR vers `main` :
1. `npm ci`
2. `npm run typecheck` (tsc --noEmit)
3. `npm run lint` (ESLint + `@typescript-eslint`)
4. `npm test` (vitest run)
5. `npm run build` (tsc)

Format via **Prettier**. Pas de Husky : les hooks locaux sont opt-in.

**Pourquoi.** Pipeline minimal mais bloquant. La discipline tient à la CI,
pas aux conventions personnelles.

---

## 7. Versions cibles (gel M1)

| Composant | Version |
|---|---|
| Node | 20.x LTS |
| TypeScript | 5.7+ |
| Fastify | 5.x |
| `@fastify/websocket` | 11.x |
| Pixi.js | 8.x |
| PostgreSQL | 16 |
| Redis | 7 |
| Drizzle ORM | 0.36+ |
| Vitest | 2.x |

---

## Récapitulatif

```
┌───────────────────┐         WebSocket          ┌────────────────────────┐
│   Client (TS)     │ ◀──── push événements ──── │                        │
│                   │                            │                        │
│  Pixi.js (carte)  │  ───── REST/JSON ───────▶  │   Fastify (Node 20)    │
│  HTML/CSS (UI)    │      actions joueur        │                        │
└───────────────────┘                            │   src/domain (TS pur)  │
                                                 │   src/server/http      │
                                                 │   src/realtime (ws)    │
                                                 │   src/persistence      │
                                                 └──────┬───────────┬─────┘
                                                        │           │
                                                ┌───────▼──┐  ┌─────▼─────┐
                                                │ Postgres │  │   Redis   │
                                                │   16     │  │     7     │
                                                └──────────┘  └───────────┘
                                                       Fly.io / Upstash
```
