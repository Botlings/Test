# `src/client` — Interface web (Pixi.js + UI HTML)

Frontend du jeu. Aucun secret, aucune règle métier — le client affiche
l'état envoyé par le serveur et émet des actions.

## Sous-modules (cibles M2)

- `render/` — scène Pixi.js (désert, ville, tokens citoyens / zombies).
- `ui/` — composants HTML (chantier, banque, fiche citoyen, chat).
- `net/` — client HTTP + client WebSocket (consomme `src/realtime/protocol.ts`).
- `state/` — store local (lecture seule du snapshot serveur).

## Build

Le client sera bundlé par Vite (à introduire en M2). Pour M1 on se limite à
l'API serveur ; la landing page statique (`index.html` à la racine du repo)
reste indépendante.
