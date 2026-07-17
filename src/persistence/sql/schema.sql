-- Hordes Revival — schéma Postgres (idempotent).
--
-- Tables :
--   accounts          : comptes joueurs (email + hash Argon2id)
--   sessions          : refresh tokens (fingerprint SHA-256)
--   towns             : parties en cours / archivées + état du moteur de jeu
--   citizens          : citoyens d'une ville (1 par compte au plus)
--   town_memberships  : index inverse compte → ville (rapide pour l'API)
--   night_events      : journal des résolutions de nuit (audit, classement)
--   night_locks       : lock NX-EX par ville pour serialiser les résolutions
--
-- Toutes les ressources (banque de la ville) sont stockées en colonnes
-- entières dénormalisées sur `towns`. Les citoyens conservent leurs PA et
-- jours de soif. Cela permet de reconstruire un `Game` complet sans JSON.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS accounts (
  id             uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  email          text          NOT NULL UNIQUE,
  password_hash  text          NOT NULL,
  created_at     timestamptz   NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  token_fingerprint  text         PRIMARY KEY,
  account_id         uuid         NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  expires_at         timestamptz  NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_account_id_idx ON sessions(account_id);

CREATE TABLE IF NOT EXISTS towns (
  id                  uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  name                text          NOT NULL,
  difficulty          text          NOT NULL CHECK (difficulty IN ('normal','hard','hardcore')),
  created_at          timestamptz   NOT NULL DEFAULT now(),
  closed              boolean       NOT NULL DEFAULT false,
  day                 integer       NOT NULL DEFAULT 1,
  phase               text          NOT NULL DEFAULT 'day' CHECK (phase IN ('day','night')),
  town_defense        integer       NOT NULL,
  game_over           boolean       NOT NULL DEFAULT false,
  next_citizen_seq    integer       NOT NULL DEFAULT 1,
  bank_wood           integer       NOT NULL DEFAULT 0,
  bank_metal          integer       NOT NULL DEFAULT 0,
  bank_water          integer       NOT NULL DEFAULT 0,
  -- Compteurs des bâtiments construits, indexés par id du catalogue
  -- (`src/domain/buildings.ts`). Forme : { "watchtower": 2, "well": 1, ... }.
  buildings           jsonb         NOT NULL DEFAULT '{}'::jsonb,
  -- Carte du désert sérialisée : { seed, radius, zones: { "x,y": Zone } }.
  -- Régénérée déterministe à partir de `desert_seed` si manquante ou invalide.
  desert              jsonb         NOT NULL DEFAULT '{}'::jsonb,
  desert_seed         bigint        NOT NULL DEFAULT 0,
  -- Gouvernance multijoueur (jalon 2) : fondateur de la ville et régime
  -- d'accès à la banque commune ('open' = libre, 'restricted' = fondateur +
  -- gestionnaires uniquement pour les dépenses de construction).
  founder_account_id  uuid                   REFERENCES accounts(id) ON DELETE SET NULL,
  bank_policy         text          NOT NULL DEFAULT 'open' CHECK (bank_policy IN ('open','restricted')),
  -- Gouvernance sociale (maire, élection, couvre-feu, votes d'exil) sérialisée
  -- en JSONB. Forme : { mayor, election, curfew, exileMotions } — cf.
  -- `src/domain/governance.ts`. Régénérée vide si absente/corrompue.
  governance          jsonb         NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT towns_resources_nonneg CHECK (
    bank_wood >= 0 AND bank_metal >= 0 AND bank_water >= 0
  )
);

-- Migration douce pour les bases déjà créées avant l'introduction du catalogue
-- de bâtiments. Sans effet sur une base neuve (colonne déjà présente).
ALTER TABLE towns
  ADD COLUMN IF NOT EXISTS buildings jsonb NOT NULL DEFAULT '{}'::jsonb;
-- Idem pour la carte du désert (jalon 4).
ALTER TABLE towns
  ADD COLUMN IF NOT EXISTS desert jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE towns
  ADD COLUMN IF NOT EXISTS desert_seed bigint NOT NULL DEFAULT 0;
-- Gouvernance multijoueur (jalon 2).
ALTER TABLE towns
  ADD COLUMN IF NOT EXISTS founder_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL;
ALTER TABLE towns
  ADD COLUMN IF NOT EXISTS bank_policy text NOT NULL DEFAULT 'open';
-- Gouvernance sociale (maire, élection, couvre-feu, votes d'exil).
ALTER TABLE towns
  ADD COLUMN IF NOT EXISTS governance jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS citizens (
  town_id                  uuid     NOT NULL REFERENCES towns(id) ON DELETE CASCADE,
  id                       text     NOT NULL,   -- ex. "c1", attribué par le Game
  account_id               uuid              REFERENCES accounts(id) ON DELETE SET NULL,
  name                     text     NOT NULL,
  alive                    boolean  NOT NULL DEFAULT true,
  location                 text     NOT NULL CHECK (location IN ('town','desert')),
  action_points            integer  NOT NULL,
  consecutive_thirst_days  integer  NOT NULL DEFAULT 0,
  cause_of_death           text,
  -- Position en désert (NULL quand le citoyen est en ville). Quand
  -- `location = 'desert'`, la paire (x, y) DOIT être renseignée.
  position_x               integer,
  position_y               integer,
  -- Gourde personnelle (eau pour fouiller en zone). Plafonnée par la config.
  water_canteen            integer  NOT NULL DEFAULT 3,
  PRIMARY KEY (town_id, id)
);
CREATE INDEX IF NOT EXISTS citizens_account_id_idx ON citizens(account_id);

-- Migrations idempotentes pour les bases pré-désert (jalon 4).
ALTER TABLE citizens ADD COLUMN IF NOT EXISTS position_x integer;
ALTER TABLE citizens ADD COLUMN IF NOT EXISTS position_y integer;
ALTER TABLE citizens ADD COLUMN IF NOT EXISTS water_canteen integer NOT NULL DEFAULT 3;

CREATE TABLE IF NOT EXISTS town_memberships (
  town_id     uuid         NOT NULL REFERENCES towns(id) ON DELETE CASCADE,
  account_id  uuid         NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  citizen_id  text         NOT NULL,
  joined_at   timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (town_id, account_id),
  FOREIGN KEY (town_id, citizen_id) REFERENCES citizens(town_id, id) ON DELETE CASCADE
);

-- Gestionnaires de banque : comptes autorisés à dépenser la banque commune
-- quand `towns.bank_policy = 'restricted'`. Le fondateur est implicite (non
-- listé ici). Jalon 2.
CREATE TABLE IF NOT EXISTS town_bank_managers (
  town_id     uuid         NOT NULL REFERENCES towns(id) ON DELETE CASCADE,
  account_id  uuid         NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  granted_at  timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (town_id, account_id)
);

-- File d'attente pour rejoindre une ville pleine. Ordre = `enqueued_at`.
-- Jalon 2. (Transitoire mais persistée pour survivre à un redémarrage.)
CREATE TABLE IF NOT EXISTS town_queue (
  town_id      uuid         NOT NULL REFERENCES towns(id) ON DELETE CASCADE,
  account_id   uuid         NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  enqueued_at  timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (town_id, account_id)
);
CREATE INDEX IF NOT EXISTS town_queue_order_idx ON town_queue(town_id, enqueued_at ASC);

CREATE TABLE IF NOT EXISTS night_events (
  id          uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  town_id     uuid         NOT NULL REFERENCES towns(id) ON DELETE CASCADE,
  day         integer      NOT NULL,
  attackers   integer      NOT NULL,
  defense     integer      NOT NULL,
  breached    boolean      NOT NULL,
  deaths      integer      NOT NULL,
  created_at  timestamptz  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS night_events_town_idx ON night_events(town_id, day);

-- Compte rendu détaillé d'une nuit (JSON sérialisé du `NightReport` domain).
-- Sert à l'affichage joueur : timeline des vagues, défense par source, décès.
CREATE TABLE IF NOT EXISTS night_reports (
  id          uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  town_id     uuid         NOT NULL REFERENCES towns(id) ON DELETE CASCADE,
  day         integer      NOT NULL,
  trigger     text         NOT NULL CHECK (trigger IN ('manual','scheduler')),
  report      jsonb        NOT NULL,
  created_at  timestamptz  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS night_reports_town_idx
  ON night_reports(town_id, created_at DESC);

-- Résultat final d'une partie terminée (victoire ou défaite). Une ligne par
-- ville ; alimente le classement global affiché sur la landing publique.
CREATE TABLE IF NOT EXISTS game_results (
  town_id        uuid         PRIMARY KEY REFERENCES towns(id) ON DELETE CASCADE,
  town_name      text         NOT NULL,
  difficulty     text         NOT NULL CHECK (difficulty IN ('normal','hard','hardcore')),
  outcome        text         NOT NULL CHECK (outcome IN ('victory','defeat')),
  days_survived  integer      NOT NULL,
  survivors      integer      NOT NULL,
  population     integer      NOT NULL,
  ended_at       timestamptz  NOT NULL DEFAULT now()
);
-- Index de support pour le tri du classement (le ORDER BY exact de la requête
-- combine outcome/jours/survivants : ce btree couvre l'essentiel du tri).
CREATE INDEX IF NOT EXISTS game_results_rank_idx
  ON game_results (days_survived DESC, survivors DESC, ended_at ASC);

CREATE TABLE IF NOT EXISTS night_locks (
  town_id      uuid         PRIMARY KEY REFERENCES towns(id) ON DELETE CASCADE,
  acquired_at  timestamptz  NOT NULL DEFAULT now()
);

-- Forum in-game : sujets (discussion ou vote), messages et votes.
-- Les options d'un vote sont stockées en JSONB (ordre conservé, ids stables).
CREATE TABLE IF NOT EXISTS forum_threads (
  id                  uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  town_id             uuid          NOT NULL REFERENCES towns(id) ON DELETE CASCADE,
  author_account_id   uuid          NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  author_citizen_name text          NOT NULL,
  title               text          NOT NULL,
  kind                text          NOT NULL CHECK (kind IN ('discussion','vote')),
  options             jsonb         NOT NULL DEFAULT '[]'::jsonb,
  closes_at           timestamptz,
  closed              boolean       NOT NULL DEFAULT false,
  created_at          timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS forum_threads_town_idx
  ON forum_threads(town_id, created_at DESC);

CREATE TABLE IF NOT EXISTS forum_messages (
  id                  uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id           uuid          NOT NULL REFERENCES forum_threads(id) ON DELETE CASCADE,
  town_id             uuid          NOT NULL REFERENCES towns(id) ON DELETE CASCADE,
  author_account_id   uuid          NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  author_citizen_name text          NOT NULL,
  body                text          NOT NULL,
  created_at          timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS forum_messages_thread_idx
  ON forum_messages(thread_id, created_at ASC);

CREATE TABLE IF NOT EXISTS forum_votes (
  thread_id    uuid          NOT NULL REFERENCES forum_threads(id) ON DELETE CASCADE,
  account_id   uuid          NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  citizen_name text          NOT NULL,
  option_id    text          NOT NULL,
  cast_at      timestamptz   NOT NULL DEFAULT now(),
  PRIMARY KEY (thread_id, account_id)
);

-- Hauts faits (achievements) débloqués par compte. Un badge permanent par
-- ligne ; le couple (account_id, achievement_id) est unique (déblocage
-- idempotent). `achievement_id` référence le catalogue applicatif
-- (`src/domain/achievements.ts`) — volontairement pas de contrainte d'enum
-- côté SQL pour ne pas migrer la base à chaque nouveau badge.
CREATE TABLE IF NOT EXISTS account_achievements (
  account_id     uuid          NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  achievement_id text          NOT NULL,
  unlocked_at    timestamptz   NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, achievement_id)
);
CREATE INDEX IF NOT EXISTS account_achievements_account_idx
  ON account_achievements(account_id, unlocked_at ASC);

-- Journal d'activité d'une ville : qui a fait quoi, quand.
-- `details` est un JSONB libre (montant, destination, etc.).
CREATE TABLE IF NOT EXISTS activity_log (
  id            uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  town_id       uuid          NOT NULL REFERENCES towns(id) ON DELETE CASCADE,
  account_id    uuid                   REFERENCES accounts(id) ON DELETE SET NULL,
  citizen_id    text,
  citizen_name  text,
  kind          text          NOT NULL,
  details       jsonb         NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS activity_log_town_idx
  ON activity_log(town_id, created_at DESC);
