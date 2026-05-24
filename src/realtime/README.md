# `src/realtime` — Canal WebSocket

Push d'événements serveur → clients d'une même ville. Le client envoie ses
actions par REST (`src/server`) ; ce module ne sert qu'au flux descendant et
au chat.

## Sous-modules (cibles M1)

- `protocol.ts` — types des messages WS, partagés client/serveur.
- `hub.ts` — registre des connexions par `townId`, broadcast et fan-out.
- `plugin.ts` — plugin Fastify qui monte l'endpoint `/ws`.

## Messages (extrait)

```ts
type ServerMessage =
  | { type: 'town.snapshot'; town: TownState }
  | { type: 'citizen.arrived'; citizenId: string; location: Location }
  | { type: 'build.completed'; structureId: string }
  | { type: 'night.start'; day: number }
  | { type: 'night.report'; report: NightReport }
  | { type: 'chat.message'; from: string; text: string; at: string };
```

Tout message est sérialisé en JSON, validé par `protocol.ts` côté client.
