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
  CONSTRAINT towns_resources_nonneg CHECK (
    bank_wood >= 0 AND bank_metal >= 0 AND bank_water >= 0
  )
);

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
  PRIMARY KEY (town_id, id)
);
CREATE INDEX IF NOT EXISTS citizens_account_id_idx ON citizens(account_id);

CREATE TABLE IF NOT EXISTS town_memberships (
  town_id     uuid         NOT NULL REFERENCES towns(id) ON DELETE CASCADE,
  account_id  uuid         NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  citizen_id  text         NOT NULL,
  joined_at   timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (town_id, account_id),
  FOREIGN KEY (town_id, citizen_id) REFERENCES citizens(town_id, id) ON DELETE CASCADE
);

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

CREATE TABLE IF NOT EXISTS night_locks (
  town_id      uuid         PRIMARY KEY REFERENCES towns(id) ON DELETE CASCADE,
  acquired_at  timestamptz  NOT NULL DEFAULT now()
);
