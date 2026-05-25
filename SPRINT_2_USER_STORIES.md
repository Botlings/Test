# Sprint 2 — User Stories Joueur (MVP onboarding)

Backlog priorisé : trois stories menant du nouvel inscrit à son premier jour de survie
complètement joué.

---

## US 1 : Créer un compte joueur

**Persona.**  
Nouvel utilisateur arrivant sur la landing page, intéressé par le jeu.

**User Story.**  
> En tant que nouvel utilisateur,  
> Je veux créer un compte avec email + mot de passe,  
> Afin d'accéder au jeu et conserver ma progression.

### Acceptance Criteria

- [ ] **AC 1.1** — Formulaire d'inscription accessible depuis la landing page (ou route `/signup`)
  - Champs : email, mot de passe (≥ 8 chars), confirmation mot de passe
  - Validation côté client : format email, matching password
  - Message d'erreur clair si création échoue (email déjà utilisé, etc.)

- [ ] **AC 1.2** — Mot de passe hashé côté serveur (Argon2id, paramètres OWASP)
  - Aucun stockage en clair en DB, pas de logs password
  - Test : appel API `/auth/register` avec email + password → création user en BDD

- [ ] **AC 1.3** — Après création réussie, l'utilisateur est automatiquement connecté
  - Génération d'un **access token JWT** (15 min) + **refresh token** (opaque en httpOnly cookie)
  - Redirection vers l'écran de création/choix de ville

- [ ] **AC 1.4** — Gestion d'erreurs clairs
  - Email déjà existant → message « Cet email est déjà utilisé »
  - Validations → messages spécifiques (« Le mot de passe doit contenir au moins 8 caractères »)
  - Erreur serveur 5xx → message générique « Une erreur est survenue »

### Notes d'implémentation

- **API Endpoint.** `POST /auth/register` (Fastify)
  - Body JSON : `{ email: string, password: string }`
  - Response : `{ accessToken: string, userId: string }` + Set-Cookie refresh token
  - Schema validation via `@fastify/type-provider-typebox`

- **Database.**  
  - Schéma `user` (id, email, password_hash, created_at)
  - Schéma `session` (token, userId, expiresAt, pour les refresh tokens)

- **Test.** Vitest : création user, collision email, hash stocké != password, token généré

---

## US 2 : Rejoindre ou créer une ville

**Persona.**  
Utilisateur authentifié cherchant à entrer dans une partie.

**User Story.**  
> En tant que joueur authentifié,  
> Je veux créer une nouvelle ville OU rejoindre une ville existante,  
> Afin de commencer ma première partie de survie coopérative.

### Acceptance Criteria

- [ ] **AC 2.1** — L'utilisateur voit un écran « Villes disponibles »
  - Liste des villes ouvertes (< 10 joueurs, partie pas terminée)
  - Pour chaque ville : nom, nombre de joueurs, jour actuel, état défense
  - Bouton « Rejoindre » pour chaque ville

- [ ] **AC 2.2** — Création d'une nouvelle ville
  - Formulaire : nom de ville (string, 3-30 chars), sélection difficulté (Normal, Difficile, Hardcore)
  - Validation client + serveur
  - Après création : utilisateur devient le premier citoyen de la ville

- [ ] **AC 2.3** — Rejoindre une ville existante
  - Clic « Rejoindre » → utilisateur devient un nouveau citoyen
  - Ses scores / historique restent indépendants (par citoyen)
  - Redirection vers le **tableau de bord de la ville**

- [ ] **AC 2.4** — Validation métier
  - Une ville peut accueillir max 10 joueurs (vérifiée côté serveur)
  - Une partie fermée/détruite n'est plus listée
  - Un utilisateur ne peut rejoindre deux fois la même ville

### Notes d'implémentation

- **API Endpoints.**  
  - `GET /towns?status=open` — lister villes ouvertes
  - `POST /towns` — créer ville (body: name, difficulty)
  - `POST /towns/:townId/join` — rejoindre ville

- **Database.**  
  - Schéma `town` (id, name, difficulty, status, created_at)
  - Schéma `citizen` (id, townId, userId, alive, water_level, created_at)

- **Broadcast WebSocket.**  
  - À la création : annonce à tous que une ville est créée → actualisation liste
  - À la jonction : notif aux citoyens de la ville « [Name] a rejoint »

- **Test.** Création + jonction, limite joueurs, état « closed »

---

## US 3 : Jouer le premier jour complet

**Persona.**  
Joueur dans une ville, expérimentant le cycle jour/nuit.

**User Story.**  
> En tant que citoyen en ville,  
> Je veux agir pendant le jour (fouiller, construire, me déplacer),  
> Puis vivre l'assaut de la nuit et la résolution (victoire, pertes, survie),  
> Afin de comprendre les mécaniques de survie du jeu.

### Acceptance Criteria

- [ ] **AC 3.1** — Écran de tableau de bord de la ville (jour)
  - État de la ville : jour actuel, heure (minutes restantes avant nuit)
  - Banque : quantités eau, bois, pierre
  - Liste des citoyens en vie + points vie
  - Défense actuelle (valeur numérique)
  - Bouton pour accéder à la carte du désert

- [ ] **AC 3.2** — Actions pendant le jour
  - **Fouiller** : le citoyen va au désert, gagne ressources (eau, bois aléatoire)
  - **Construire** : passer +X à la défense (coûte ressources)
  - **Se déplacer** : déplacement dans le désert (13×13 grille, cases adjacentes)
  - Chaque action coûte 1 point d'action (APM ou tour simple)

- [ ] **AC 3.3** — Gestion de l'eau et faim (premier jour simplifié)
  - Chaque citoyen gagne 1 eau à minuit (sauf nuit nulle)
  - Chaque action (fouille, déplacement) consomme 0.5 eau
  - Si eau = 0 après deux jours sans eau : citoyen meurt
  - Affichage barre eau/citoyen

- [ ] **AC 3.4** — Résolution de la nuit automatique
  - À T=0 d'un jour (minuit), le jeu déclenche résolution :
    - Horde force = 10 + (day - 1) * 2
    - Défense < Horde force → débordement, pertes aléatoires parmi citoyens
    - Résumé de nuit : " Horde force: 12, Défense: 8, **Débordement!** 2 citoyens morts "
  - Affichage sur tous les clients via WebSocket

- [ ] **AC 3.5** — Fin du jour et transition au jour suivant
  - Nuit résolue → affichage compte-rendu
  - Bouton « Continuer » → passe au jour 2
  - Si tous citoyens morts → écran « Partie perdue »
  - Si partie survit 7 jours → écran « Partie gagnée »

- [ ] **AC 3.6** — Synchronisation multijoueur
  - Les actions d'un citoyen sont visibles en temps réel aux autres joueurs (WebSocket)
  - La nuit se résout **une seule fois** (lock Redis) et se broad­cast à tous
  - Les clients affichent le même résumé de nuit

### Notes d'implémentation

- **API Endpoints.**  
  - `GET /towns/:townId` — état complet (citoyens, banque, défense, jour)
  - `POST /towns/:townId/citizens/:citizenId/action` — action joueur (forage, construction, déplacement)
  - `POST /towns/:townId/night` — résoudre la nuit (déclenché par cron ou client, avec lock Redis)

- **WebSocket Protocol.**  
  ```ts
  // Types dans src/realtime/protocol.ts
  type Message = 
    | { type: 'citizen.acted'; citizenId; action; } 
    | { type: 'night.start'; }
    | { type: 'night.resolved'; summary; deathCitizens; remainingWater; }
    | { type: 'town.updated'; state; }
  ```

- **Domain Engine.**  
  - Utiliser `src/domain/` pour résolution nuit
  - Moteur déterministe : même entrée = même résultat (pour tests déterministes)
  - Entrée : (town state, horde force, défense, citoyens vivants)
  - Sortie : (deaths array, casualties, damage)

- **Database.**  
  - Schéma `night_event` (id, townId, day, horde_force, defense, casualties)
  - Schéma `action` (id, citizenId, type, day, timestamp)

- **Test.**  
  - Vitest : forage + ressources, construction + défense, résolution nuit déterministe
  - WebSocket : broadcast résumé nuit à tous joueurs
  - Lock Redis : deux résolutions simultanées → une seule gagne

---

## 📊 Dépendances et ordonnancement

```
US 1 (Créer compte)
    ↓
US 2 (Rejoindre ville)
    ↓
US 3 (Jour + Nuit)
```

**Estimations points (Fibonacci).**
- US 1 : **5 pts** (auth, JWT, Argon2id)
- US 2 : **8 pts** (logique ville, WebSocket broadcast, listage)
- US 3 : **13 pts** (moteur jour, actions, résolution nuit, sync WS)

**Total Sprint 2 : 26 points** (2 semaines @ 13 pts/semaine = possible sur deux sprints).

---

## 🎯 Succès du Sprint 2

Un utilisateur peut :

1. ✅ S'inscrire avec email + password
2. ✅ Créer une nouvelle ville (ou rejoindre)
3. ✅ Jouer un jour complet (forage, construction, déplacement)
4. ✅ Survivre ou mourir à la première nuit
5. ✅ Voir les actions d'autres joueurs en temps réel
6. ✅ Accéder à l'état de jeu via API REST + WebSocket

Aucune interface Pixi.js ni HTML n'est requise en Sprint 2 : les actions se font via API REST + consultation d'état JSON (ou CLI pour tester). L'interface graphique est **M2**.
