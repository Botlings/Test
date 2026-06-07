# `infra/` — configuration d'infrastructure

Ce dossier centralise tout ce qui n'est ni code applicatif ni tests mais
sert au déploiement.

## Pourquoi `infra/github-actions/` au lieu de `.github/workflows/` ?

Le Personal Access Token utilisé par l'automatisation MiniCorp n'a **pas**
le scope `workflow`. Pousser un fichier sous `.github/workflows/` lèverait
`refusing to allow a Personal Access Token to create or update workflow`.

Les workflows sont donc versionnés ici en tant que **templates** ; ils
doivent être copiés en `.github/workflows/` par un humain disposant du
bon scope :

```sh
mkdir -p .github/workflows
cp infra/github-actions/ci.yml .github/workflows/ci.yml
cp infra/github-actions/deploy.yml .github/workflows/deploy.yml
git add .github/workflows
git commit -m "ci: activer pipelines CI + déploiement Render"
git push origin main
```

Une fois en place, ils s'exécutent à chaque push sur `main` et chaque
pull request. Toute évolution doit se faire **d'abord** ici, puis être
recopiée sous `.github/workflows/` (idem PAT).

## Fichiers

| Chemin | Rôle |
|---|---|
| `github-actions/ci.yml` | Pipeline de validation (typecheck, vitest avec Postgres jetable, build Docker). |
| `github-actions/deploy.yml` | Déclenche le Deploy Hook Render après un CI vert sur `main`, puis attend que `/health/ready` réponde 200. |

## Secrets requis dans le repo GitHub

Settings → Secrets and variables → Actions → New repository secret :

- `RENDER_DEPLOY_HOOK_URL` — copié depuis le dashboard Render
  (Service → Settings → Deploy Hook). Permet de déclencher un déploiement
  sans donner les clés API Render.

## Lien avec les autres fichiers d'infra (racine du repo)

- `Dockerfile` — image utilisée par Render/Railway et le compose local.
- `render.yaml` — Blueprint Render (web + Postgres managé).
- `railway.json` — alternative Railway.
- `docker-compose.yml` — stack de dev local (Postgres + API).
- `.env.example` — variables attendues par le serveur.

La décision d'hébergeur, la procédure DNS hordesrevival.com et le
monitoring uptime sont documentés dans
`.minicorp/docs/cto/infrastructure-cloud.md`.
