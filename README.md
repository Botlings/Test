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

## Stack

Node.js + TypeScript, en vue d'un browser game full-stack mono-langage.

## Commandes

```sh
npm install      # installe les dépendances
npm run build    # compile le TypeScript
npm test         # lance la suite de tests (vitest)
npm run demo     # joue une partie de démonstration en console
```

## Structure

```
src/domain/   moteur de jeu (modèle de domaine, déterministe, sans I/O)
src/index.ts  démonstration jouable en console
tests/        suite de tests du moteur
```

Voir [ROADMAP.md](./ROADMAP.md) pour l'avancement.
