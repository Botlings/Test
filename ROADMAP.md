# Roadmap

Roadmap courante du projet. Les jalons `done` sont figés ; le jalon `active`
est celui sur lequel l'équipe travaille en ce moment.

## ✅ M0 — Fondations (done)

- Scaffolding du dépôt : Node + TypeScript, `tsc`, `vitest`.
- Moteur de jeu de domaine déterministe (`src/domain`) :
  - cycle jour/nuit, citoyens, banque de ressources ;
  - actions de jour : construire, fouiller le désert, se déplacer ;
  - résolution de la nuit : assaut de la horde, percée, pertes ;
  - soif et déshydratation.
- Suite de tests couvrant le moteur.
- Démonstration jouable en console (`npm run demo`).

## 🚧 M1 — Serveur de partie & API (active)

- Couche d'état persistante d'une partie (en mémoire puis stockage).
- API HTTP (Fastify) : créer une partie, rejoindre, agir, consulter l'état.
- Modèle multijoueur : plusieurs joueurs réels dans une même ville.
- Résolution de la nuit déclenchée par un cycle temps réel.

## 📋 M2 — Client web

- Interface de la ville : chantier, banque, citoyens.
- Carte du désert et déplacement case par case.
- Affichage du compte rendu de nuit.

## 📋 M3 — Profondeur de jeu

- Catalogue de bâtiments et d'objets (au-delà de la défense brute).
- Métiers et compétences des citoyens.
- Chantiers collaboratifs, votes de ville, chat.
- Permadeath et classement des villes.
