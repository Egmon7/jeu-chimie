import { createHash, randomBytes, randomInt } from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";
import { buildLearnReport } from "./learnReport.js";
import { LEARN_PEOPLE, learnNameKey } from "./learn.js";

const envFile = path.join(path.dirname(fileURLToPath(import.meta.url)), "../.env");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match && process.env[match[1]] == null) process.env[match[1]] = match[2];
  }
}

const url = process.env.DATABASE_URL || "";
const ownerUrl = process.env.DATABASE_OWNER_URL || "";
const pool = url
  ? new pg.Pool({
    connectionString: url,
    max: 5,
    statement_timeout: 10_000,
    idle_in_transaction_session_timeout: 30_000,
  })
  : null;
if (pool) pool.on("error", (error) => console.error("Base:", error.message));

function quoteIdent(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

const CONSTRAINTS = [
  ["games", "games_mode_check", "CHECK (mode IN ('solo', 'local', 'online'))"],
  ["games", "games_player_fk", "FOREIGN KEY (player_id) REFERENCES profiles (id) ON DELETE RESTRICT"],
  ["sessions", "sessions_player_fk", "FOREIGN KEY (player_id) REFERENCES profiles (id) ON DELETE CASCADE"],
  ["reset_codes", "reset_codes_player_fk", "FOREIGN KEY (player_id) REFERENCES profiles (id) ON DELETE CASCADE"],
];
let ready = false;

export function dbReady() {
  return ready;
}

export const SESSION_DAYS = 90;
const RESET_MINUTES = 15;
export const RESET_TRIES = 5;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value) {
  return UUID.test(String(value || ""));
}

export async function initDb() {
  if (!pool) return;
  const separate = Boolean(ownerUrl) && ownerUrl !== url;
  const owner = separate ? new pg.Pool({ connectionString: ownerUrl, max: 1 }) : pool;
  try {
    await migrate(owner);
    if (separate) {
      const appUser = quoteIdent(decodeURIComponent(new URL(url).username));
      await owner.query(`GRANT USAGE ON SCHEMA public TO ${appUser}`);
      await owner.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${appUser}`);
    }
  } finally {
    if (separate) await owner.end();
  }
  ready = true;
}

async function migrate(owner) {
  await owner.query(`
    CREATE TABLE IF NOT EXISTS profiles (
      id uuid PRIMARY KEY,
      name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
      email text NOT NULL DEFAULT '',
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS games (
      id uuid PRIMARY KEY,
      player_id uuid NOT NULL,
      played_at timestamptz NOT NULL,
      mode text NOT NULL,
      sheet text NOT NULL,
      names jsonb NOT NULL,
      scores jsonb NOT NULL,
      winner text NOT NULL,
      user_seat int,
      reason text,
      difficulty text
    );
    CREATE INDEX IF NOT EXISTS games_player_played ON games (player_id, played_at DESC);
    CREATE TABLE IF NOT EXISTS messages (
      id uuid PRIMARY KEY,
      name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
      body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 800),
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  await owner.query("ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_email_check");
  await owner.query(`
    ALTER TABLE profiles ADD CONSTRAINT profiles_email_check
    CHECK (email = '' OR char_length(email) BETWEEN 3 AND 80)
  `);
  await owner.query("ALTER TABLE profiles ADD COLUMN IF NOT EXISTS icon text NOT NULL DEFAULT 'dot'");
  await owner.query("ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_icon_check");
  await owner.query(`
    ALTER TABLE profiles ADD CONSTRAINT profiles_icon_check
    CHECK (icon IN ('dot', 'house', 'star', 'crown', 'pen', 'book', 'flame', 'gem'))
  `);
  await owner.query("ALTER TABLE profiles ADD COLUMN IF NOT EXISTS photo text NOT NULL DEFAULT ''");
  await owner.query("ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_photo_check");
  await owner.query(`
    ALTER TABLE profiles ADD CONSTRAINT profiles_photo_check
    CHECK (photo = '' OR photo ~ '^https://res\\.cloudinary\\.com/ka4h4lpk/image/upload/[A-Za-z0-9_./%-]{1,360}$')
  `);
  await owner.query("ALTER TABLE games ADD COLUMN IF NOT EXISTS duration_ms integer");
  await owner.query("ALTER TABLE games ADD COLUMN IF NOT EXISTS behind boolean NOT NULL DEFAULT false");
  await owner.query("ALTER TABLE games ADD COLUMN IF NOT EXISTS clean boolean NOT NULL DEFAULT false");
  await owner.query("ALTER TABLE profiles ADD COLUMN IF NOT EXISTS password_hash text NOT NULL DEFAULT ''");
  await owner.query("ALTER TABLE profiles ADD COLUMN IF NOT EXISTS created_at timestamptz");
  await owner.query("UPDATE profiles SET created_at = updated_at WHERE created_at IS NULL");
  await owner.query("ALTER TABLE profiles ALTER COLUMN created_at SET DEFAULT now()");
  await owner.query("ALTER TABLE profiles ALTER COLUMN created_at SET NOT NULL");
  try {
    await owner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS profiles_email_unique
      ON profiles (lower(email))
      WHERE email <> ''
    `);
  } catch (error) {
    console.error("Index e-mail:", error.message);
  }
  await owner.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash text PRIMARY KEY,
      player_id uuid NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await owner.query("CREATE INDEX IF NOT EXISTS sessions_player ON sessions (player_id)");
  await owner.query("ALTER TABLE sessions ADD COLUMN IF NOT EXISTS expires_at timestamptz");
  await owner.query(`UPDATE sessions SET expires_at = created_at + interval '${SESSION_DAYS} days' WHERE expires_at IS NULL`);
  await owner.query(`ALTER TABLE sessions ALTER COLUMN expires_at SET DEFAULT now() + interval '${SESSION_DAYS} days'`);
  await owner.query("ALTER TABLE sessions ALTER COLUMN expires_at SET NOT NULL");
  await owner.query("ALTER TABLE profiles ADD COLUMN IF NOT EXISTS public_id uuid NOT NULL DEFAULT gen_random_uuid()");
  await owner.query("CREATE UNIQUE INDEX IF NOT EXISTS profiles_public_id ON profiles (public_id)");
  await owner.query(`
    CREATE TABLE IF NOT EXISTS reset_codes (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      player_id uuid NOT NULL,
      code_hash text NOT NULL,
      attempts int NOT NULL DEFAULT 0,
      expires_at timestamptz NOT NULL,
      used_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await owner.query("CREATE INDEX IF NOT EXISTS reset_codes_player ON reset_codes (player_id, created_at DESC)");
  await owner.query(`
    CREATE TABLE IF NOT EXISTS visits (
      player_id uuid NOT NULL,
      day date NOT NULL,
      PRIMARY KEY (player_id, day)
    )
  `);
  await owner.query("CREATE INDEX IF NOT EXISTS visits_day ON visits (day)");
  await owner.query(`
    CREATE TABLE IF NOT EXISTS notifications (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      player_id uuid NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
      kind text NOT NULL,
      ref text NOT NULL DEFAULT '' CHECK (char_length(ref) <= 80),
      title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
      body text NOT NULL DEFAULT '' CHECK (char_length(body) <= 400),
      link text NOT NULL DEFAULT '' CHECK (char_length(link) <= 40),
      created_at timestamptz NOT NULL DEFAULT now(),
      read_at timestamptz
    )
  `);
  await owner.query("ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_kind_check");
  await owner.query(`
    ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
    CHECK (kind IN ('welcome', 'challenge', 'invite', 'streak', 'message', 'tournament', 'match'))
  `);
  await owner.query("CREATE INDEX IF NOT EXISTS notifications_player ON notifications (player_id, created_at DESC)");
  await owner.query("CREATE UNIQUE INDEX IF NOT EXISTS notifications_once ON notifications (player_id, kind, ref) WHERE ref <> ''");
  await owner.query(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint text PRIMARY KEY CHECK (char_length(endpoint) <= 1000 AND endpoint LIKE 'https://%'),
      player_id uuid NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
      p256dh text NOT NULL,
      auth text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await owner.query("CREATE INDEX IF NOT EXISTS push_subscriptions_player ON push_subscriptions (player_id)");
  await owner.query(`
    CREATE TABLE IF NOT EXISTS tournaments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      code text NOT NULL UNIQUE CHECK (code ~ '^TRN-[A-HJ-NP-Z2-9]{6}$'),
      name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
      size int NOT NULL DEFAULT 4 CHECK (size IN (4, 8)),
      creator_id uuid NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
      official boolean NOT NULL DEFAULT false,
      status text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'running', 'finished', 'cancelled')),
      winner_id uuid REFERENCES profiles (id) ON DELETE SET NULL,
      runner_up_id uuid REFERENCES profiles (id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      started_at timestamptz,
      finished_at timestamptz
    )
  `);
  await owner.query(`
    CREATE TABLE IF NOT EXISTS tournament_players (
      tournament_id uuid NOT NULL REFERENCES tournaments (id) ON DELETE CASCADE,
      player_id uuid NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
      seat int,
      joined_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tournament_id, player_id)
    )
  `);
  await owner.query("CREATE INDEX IF NOT EXISTS tournament_players_player ON tournament_players (player_id)");
  await owner.query(`
    CREATE TABLE IF NOT EXISTS tournament_matches (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tournament_id uuid NOT NULL REFERENCES tournaments (id) ON DELETE CASCADE,
      round text NOT NULL CHECK (round IN ('quarter', 'semi', 'final')),
      slot int NOT NULL,
      p1 uuid REFERENCES profiles (id) ON DELETE SET NULL,
      p2 uuid REFERENCES profiles (id) ON DELETE SET NULL,
      status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'playing', 'done')),
      winner uuid REFERENCES profiles (id) ON DELETE SET NULL,
      scores jsonb,
      reason text,
      started_at timestamptz,
      finished_at timestamptz,
      UNIQUE (tournament_id, round, slot)
    )
  `);
  await owner.query("ALTER TABLE tournament_matches ADD COLUMN IF NOT EXISTS room_code text");
  await owner.query("ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS starts_at timestamptz");
  await owner.query("ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS unlisted boolean NOT NULL DEFAULT false");
  await owner.query(`
    CREATE TABLE IF NOT EXISTS push_marks (
      player_id uuid NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
      kind text NOT NULL CHECK (char_length(kind) <= 20),
      sent_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (player_id, kind)
    )
  `);
  await owner.query(`
    CREATE TABLE IF NOT EXISTS learn_matches (
      id uuid PRIMARY KEY,
      fingerprint text NOT NULL UNIQUE,
      room_code text NOT NULL DEFAULT '',
      player0_id uuid NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
      player1_id uuid NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
      player0_name text NOT NULL CHECK (char_length(player0_name) BETWEEN 1 AND 40),
      player1_name text NOT NULL CHECK (char_length(player1_name) BETWEEN 1 AND 40),
      started_at timestamptz NOT NULL,
      ended_at timestamptz NOT NULL,
      duration_ms integer,
      rows int NOT NULL,
      cols int NOT NULL,
      starter int NOT NULL DEFAULT 0 CHECK (starter IN (0, 1)),
      scores jsonb NOT NULL,
      winner text NOT NULL,
      reason text,
      settings jsonb NOT NULL DEFAULT '{}'::jsonb,
      move_count int NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await owner.query("CREATE INDEX IF NOT EXISTS learn_matches_ended ON learn_matches (ended_at DESC)");
  await owner.query(`
    CREATE TABLE IF NOT EXISTS learn_moves (
      match_id uuid NOT NULL REFERENCES learn_matches (id) ON DELETE CASCADE,
      step int NOT NULL CHECK (step >= 0),
      seat int NOT NULL CHECK (seat IN (0, 1)),
      r int NOT NULL,
      c int NOT NULL,
      before_board jsonb NOT NULL,
      after_board jsonb NOT NULL,
      played_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (match_id, step)
    )
  `);
  await owner.query(`
    CREATE TABLE IF NOT EXISTS learn_situations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      match_id uuid NOT NULL REFERENCES learn_matches (id) ON DELETE CASCADE,
      step int NOT NULL CHECK (step >= 0),
      kind text NOT NULL CHECK (kind IN ('chain_short', 'chain_long', 'endgame', 'sacrifice', 'double_cross')),
      seat int NOT NULL CHECK (seat IN (0, 1)),
      outcome text NOT NULL CHECK (outcome IN ('win', 'loss', 'draw')),
      size int NOT NULL DEFAULT 0,
      detail jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (match_id, step, kind)
    )
  `);
  await owner.query("CREATE INDEX IF NOT EXISTS learn_situations_kind ON learn_situations (kind, outcome)");
  await owner.query(`
    DO $$
    DECLARE item record;
    BEGIN
      FOR item IN
        SELECT conname, a.attname AS col
        FROM pg_constraint k
        JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = ANY (k.conkey)
        WHERE k.conrelid = 'learn_matches'::regclass AND k.contype = 'f' AND k.confdeltype <> 'c'
      LOOP
        EXECUTE format('ALTER TABLE learn_matches DROP CONSTRAINT %I', item.conname);
        EXECUTE format('ALTER TABLE learn_matches ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES profiles (id) ON DELETE CASCADE', item.conname, item.col);
      END LOOP;
    END $$;
  `);
  await owner.query("ALTER TABLE learn_matches ALTER COLUMN player1_id DROP NOT NULL");
  await owner.query("ALTER TABLE learn_matches ADD COLUMN IF NOT EXISTS opponent text NOT NULL DEFAULT 'online'");
  await owner.query("ALTER TABLE learn_matches ADD COLUMN IF NOT EXISTS difficulty text");
  await owner.query("ALTER TABLE learn_moves ALTER COLUMN before_board DROP NOT NULL");
  await owner.query("ALTER TABLE learn_moves ALTER COLUMN after_board DROP NOT NULL");
  await owner.query(`
    CREATE TABLE IF NOT EXISTS learn_meta (
      id int PRIMARY KEY CHECK (id = 1),
      active_version text NOT NULL DEFAULT 'v1',
      candidate_version text,
      status text NOT NULL DEFAULT 'pas commencé'
        CHECK (status IN ('pas commencé', 'collecte', 'analyse', 'entrainement', 'validation', 'termine', 'echec')),
      veryhard_candidate boolean NOT NULL DEFAULT false,
      expert_candidate boolean NOT NULL DEFAULT false,
      last_run_at timestamptz,
      last_error text NOT NULL DEFAULT '',
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await owner.query(`
    INSERT INTO learn_meta (id) VALUES (1)
    ON CONFLICT (id) DO NOTHING
  `);
  await owner.query("ALTER TABLE learn_meta ADD COLUMN IF NOT EXISTS watch jsonb NOT NULL DEFAULT '{}'::jsonb");
  await owner.query(`
    CREATE TABLE IF NOT EXISTS learn_runs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      kind text NOT NULL CHECK (kind IN ('collecte', 'analyse', 'entrainement', 'validation', 'activation', 'retour', 'echec')),
      status text NOT NULL CHECK (status IN ('ok', 'echec')),
      model_version text NOT NULL DEFAULT 'v1',
      matches int NOT NULL DEFAULT 0,
      moves int NOT NULL DEFAULT 0,
      situations int NOT NULL DEFAULT 0,
      report text NOT NULL DEFAULT '',
      detail jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await owner.query("CREATE INDEX IF NOT EXISTS learn_runs_created ON learn_runs (created_at DESC)");
  await owner.query(`
    INSERT INTO visits (player_id, day)
    SELECT DISTINCT player_id, (played_at AT TIME ZONE 'Europe/Paris')::date FROM games
    ON CONFLICT DO NOTHING
  `);
  await owner.query(`
    INSERT INTO visits (player_id, day)
    SELECT DISTINCT player_id, (created_at AT TIME ZONE 'Europe/Paris')::date FROM sessions
    ON CONFLICT DO NOTHING
  `);
  for (const [table, name, rule] of CONSTRAINTS) {
    const { rows } = await owner.query("SELECT convalidated FROM pg_constraint WHERE conname = $1", [name]);
    if (!rows[0]) await owner.query(`ALTER TABLE ${table} ADD CONSTRAINT ${name} ${rule} NOT VALID`);
    if (rows[0]?.convalidated) continue;
    try {
      await owner.query(`ALTER TABLE ${table} VALIDATE CONSTRAINT ${name}`);
    } catch (error) {
      console.error(`Contrainte ${name}:`, error.message);
    }
  }
}

export async function recordVisit(playerId) {
  if (!pool || !isUuid(playerId)) return;
  await pool.query(
    `INSERT INTO visits (player_id, day)
     VALUES ($1, (now() AT TIME ZONE 'Europe/Paris')::date)
     ON CONFLICT DO NOTHING`,
    [playerId],
  );
}

export async function upsertProfile({ id, name, email, icon, photo }) {
  const { rows } = await pool.query(
    `INSERT INTO profiles (id, name, email, icon, photo)
     VALUES ($1, $2, $3, COALESCE($4, 'dot'), COALESCE($5, ''))
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name,
       email = EXCLUDED.email,
       icon = COALESCE($4, profiles.icon),
       photo = COALESCE($5, profiles.photo),
       updated_at = now()
     RETURNING name, email, icon, photo`,
    [id, name, email, icon || null, photo],
  );
  forgetRanking();
  return rows[0];
}

export async function readProfile(id) {
  const { rows } = await pool.query("SELECT name, email, icon, photo FROM profiles WHERE id = $1", [id]);
  return rows[0] || null;
}

export async function findByName(name) {
  const { rows } = await pool.query(
    `SELECT id, name, email, icon, photo, password_hash
     FROM profiles
     WHERE lower(name) = lower($1)
     ORDER BY (password_hash <> '') DESC, updated_at DESC
     LIMIT 2`,
    [name],
  );
  return rows;
}

export async function findAccount(email) {
  const { rows } = await pool.query(
    `SELECT id, name, email, icon, photo, password_hash
     FROM profiles
     WHERE lower(email) = lower($1)
     ORDER BY (password_hash <> '') DESC, updated_at DESC
     LIMIT 1`,
    [email],
  );
  return rows[0] || null;
}

export async function emailTaken(email, exceptId) {
  const { rows } = await pool.query(
    "SELECT id FROM profiles WHERE lower(email) = lower($1) AND id <> $2 LIMIT 1",
    [email, exceptId],
  );
  return Boolean(rows[0]);
}

async function accountById(id) {
  const { rows } = await pool.query(
    "SELECT id, email, password_hash FROM profiles WHERE id = $1",
    [id],
  );
  return rows[0] || null;
}

export async function saveAccount({ id, name, email, passwordHash }) {
  const byEmail = await findAccount(email);
  if (byEmail && byEmail.id !== id) return { error: "Cet e-mail a déjà un profil." };
  const byId = byEmail?.id === id ? byEmail : await accountById(id);
  if (byId?.password_hash) return { error: "Ce profil a déjà un mot de passe." };
  try {
    const { rows } = byId
      ? await pool.query(
        `UPDATE profiles
         SET name = $2, email = $3, password_hash = $4, updated_at = now()
         WHERE id = $1
         RETURNING id, name, email, icon, photo`,
        [byId.id, name, email, passwordHash],
      )
      : await pool.query(
        `INSERT INTO profiles (id, name, email, password_hash)
         VALUES ($1, $2, $3, $4)
         RETURNING id, name, email, icon, photo`,
        [id, name, email, passwordHash],
      );
    if (!rows[0]) return { error: "Profil introuvable." };
    forgetRanking();
    return { profile: rows[0] };
  } catch (error) {
    if (error.code === "23505") return { error: "Cet e-mail a déjà un profil." };
    throw error;
  }
}

export async function findLoginByName(name) {
  const { rows } = await pool.query(
    `SELECT id, name, email, icon, photo, password_hash
     FROM profiles
     WHERE lower(name) = lower($1) AND password_hash <> ''
     LIMIT 2`,
    [name],
  );
  return rows.length === 1 ? rows[0] : null;
}

export async function passwordHashOf(id) {
  const { rows } = await pool.query("SELECT password_hash FROM profiles WHERE id = $1", [id]);
  return rows[0]?.password_hash || "";
}

export async function setOwnPassword(id, passwordHash) {
  const { rows } = await pool.query(
    `UPDATE profiles
     SET password_hash = $2, updated_at = now()
     WHERE id = $1
     RETURNING id`,
    [id, passwordHash],
  );
  return Boolean(rows[0]);
}

function tokenHash(token) {
  return createHash("sha256").update(String(token)).digest("hex");
}

export async function openSession(playerId) {
  const token = randomBytes(32).toString("base64url");
  await pool.query("DELETE FROM sessions WHERE expires_at < now()");
  await pool.query(
    "INSERT INTO sessions (token_hash, player_id) VALUES ($1, $2)",
    [tokenHash(token), playerId],
  );
  return token;
}

export async function sessionPlayer(token) {
  const value = String(token || "");
  if (value.length < 20 || value.length > 200) return "";
  const { rows } = await pool.query(
    "SELECT player_id FROM sessions WHERE token_hash = $1 AND expires_at > now()",
    [tokenHash(value)],
  );
  return rows[0]?.player_id || "";
}

export async function closeSession(token) {
  const value = String(token || "");
  if (value.length < 20 || value.length > 200) return;
  await pool.query("DELETE FROM sessions WHERE token_hash = $1", [tokenHash(value)]);
}

export async function closeOtherSessions(playerId, keepToken = "") {
  await pool.query(
    "DELETE FROM sessions WHERE player_id = $1 AND token_hash <> $2",
    [playerId, keepToken ? tokenHash(keepToken) : ""],
  );
}

function codeHash(playerId, code) {
  return createHash("sha256").update(`${playerId}:${code}`).digest("hex");
}

export async function saveResetCode(playerId, code) {
  await pool.query("DELETE FROM reset_codes WHERE player_id = $1 OR expires_at < now() - interval '1 day'", [playerId]);
  await pool.query(
    `INSERT INTO reset_codes (player_id, code_hash, expires_at)
     VALUES ($1, $2, now() + interval '${RESET_MINUTES} minutes')`,
    [playerId, codeHash(playerId, code)],
  );
}

export async function useResetCode(playerId, code) {
  const { rows } = await pool.query(
    `UPDATE reset_codes
     SET used_at = now()
     WHERE player_id = $1 AND code_hash = $2 AND used_at IS NULL
       AND expires_at > now() AND attempts < $3
     RETURNING id`,
    [playerId, codeHash(playerId, code), RESET_TRIES],
  );
  if (rows[0]) return true;
  await pool.query(
    `UPDATE reset_codes
     SET attempts = attempts + 1
     WHERE player_id = $1 AND used_at IS NULL AND expires_at > now()`,
    [playerId],
  );
  return false;
}

function winnerOut(value) {
  if (value === "draw") return "draw";
  const n = Number(value);
  return n === 0 || n === 1 ? n : "draw";
}

function jsonBody(value) {
  if (typeof value === "string") {
    try {
      JSON.parse(value);
      return value;
    } catch {
      return JSON.stringify(value);
    }
  }
  return JSON.stringify(value ?? null);
}

export async function insertGame(playerId, entry) {
  const names = (Array.isArray(entry.names) ? entry.names : [])
    .slice(0, 2)
    .map((name) => String(name ?? "").slice(0, 40));
  const scores = (Array.isArray(entry.scores) ? entry.scores : [])
    .slice(0, 2)
    .map((score) => {
      const n = Number(score);
      return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
    });
  while (scores.length < 2) scores.push(0);
  const winner = entry.winner === 0 || entry.winner === 1 || entry.winner === "0" || entry.winner === "1"
    ? String(Number(entry.winner))
    : "draw";
  await pool.query(
    `INSERT INTO games (id, player_id, played_at, mode, sheet, names, scores, winner, user_seat, reason, difficulty, duration_ms, behind, clean)
     VALUES ($1, $2, to_timestamp($3 / 1000.0), $4, $5, $6::text::jsonb, $7::text::jsonb, $8, $9, $10, $11, $12, $13, $14)
     ON CONFLICT (id) DO NOTHING`,
    [
      entry.id,
      playerId,
      Number(entry.at) || Date.now(),
      String(entry.mode || "solo").slice(0, 16),
      String(entry.size || "").slice(0, 16),
      jsonBody(names),
      jsonBody(scores),
      winner,
      entry.userSeat === 0 || entry.userSeat === 1 ? entry.userSeat : null,
      entry.reason ? String(entry.reason).slice(0, 24) : null,
      entry.difficulty ? String(entry.difficulty).slice(0, 16) : null,
      Number.isInteger(entry.durationMs) ? entry.durationMs : null,
      entry.behind === true,
      entry.clean === true,
    ],
  );
  forgetRanking();
}

export async function gameStats(playerId) {
  const blank = () => ({ played: 0, wins: 0, losses: 0, draws: 0 });
  const { rows } = await pool.query(
    `SELECT mode,
       COUNT(*)::int AS played,
       COUNT(*) FILTER (WHERE user_seat IN (0, 1) AND winner = user_seat::text)::int AS wins,
       COUNT(*) FILTER (WHERE winner = 'draw')::int AS draws,
       COUNT(*) FILTER (WHERE user_seat IN (0, 1) AND winner <> 'draw' AND winner <> user_seat::text)::int AS losses
     FROM games
     WHERE player_id = $1
     GROUP BY mode`,
    [playerId],
  );
  const general = blank();
  const online = blank();
  for (const row of rows) {
    const add = (target) => {
      target.played += Number(row.played) || 0;
      target.wins += Number(row.wins) || 0;
      target.losses += Number(row.losses) || 0;
      target.draws += Number(row.draws) || 0;
    };
    add(general);
    if (row.mode === "online") add(online);
  }
  return { general, online };
}

export async function listGames(playerId) {
  const { rows } = await pool.query(
    `SELECT id, played_at, mode, sheet, names, scores, winner, user_seat, reason, difficulty, duration_ms, behind, clean
     FROM games WHERE player_id = $1 ORDER BY played_at DESC LIMIT 40`,
    [playerId],
  );
  return rows.map((row) => ({
    id: row.id,
    at: new Date(row.played_at).getTime(),
    mode: row.mode,
    size: row.sheet,
    names: row.names,
    scores: row.scores,
    winner: winnerOut(row.winner),
    userSeat: row.user_seat,
    reason: row.reason,
    difficulty: row.difficulty,
    durationMs: Number(row.duration_ms) || 0,
    behind: row.behind === true,
    clean: row.clean === true,
  }));
}

const NOTE_KEEP = 100;

function noteOut(row) {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    link: row.link,
    at: new Date(row.created_at).getTime(),
    read: row.read_at != null,
  };
}

export async function addNotification({ playerId, kind, ref = "", title, body = "", link = "" }) {
  const { rows } = await pool.query(
    `INSERT INTO notifications (player_id, kind, ref, title, body, link)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (player_id, kind, ref) WHERE ref <> '' DO NOTHING
     RETURNING id, kind, title, body, link, created_at, read_at`,
    [playerId, kind, ref, title.slice(0, 120), body.slice(0, 400), link.slice(0, 40)],
  );
  if (!rows[0]) return null;
  await pool.query(
    `DELETE FROM notifications WHERE player_id = $1 AND id NOT IN (
       SELECT id FROM notifications WHERE player_id = $1 ORDER BY created_at DESC LIMIT $2
     )`,
    [playerId, NOTE_KEEP],
  );
  return noteOut(rows[0]);
}

export async function listNotifications(playerId) {
  const [{ rows }, { rows: count }] = await Promise.all([
    pool.query(
      `SELECT id, kind, title, body, link, created_at, read_at FROM notifications
       WHERE player_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [playerId],
    ),
    pool.query("SELECT COUNT(*)::int AS unread FROM notifications WHERE player_id = $1 AND read_at IS NULL", [playerId]),
  ]);
  return { items: rows.map(noteOut), unread: count[0]?.unread || 0 };
}

export async function readNotifications(playerId) {
  await pool.query("UPDATE notifications SET read_at = now() WHERE player_id = $1 AND read_at IS NULL", [playerId]);
}

export async function onlineWinStreak(playerId) {
  const { rows } = await pool.query(
    `SELECT id, winner = user_seat::text AS won FROM games
     WHERE player_id = $1 AND mode = 'online' AND user_seat IN (0, 1)
     ORDER BY played_at DESC LIMIT 4`,
    [playerId],
  );
  let streak = 0;
  for (const row of rows) {
    if (!row.won) break;
    streak += 1;
  }
  return { streak, last: rows[0]?.id || "" };
}

const PUSH_PER_PLAYER = 5;

export async function savePushSubscription(playerId, sub) {
  await pool.query(
    `INSERT INTO push_subscriptions (endpoint, player_id, p256dh, auth)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (endpoint) DO UPDATE SET player_id = $2, p256dh = $3, auth = $4, created_at = now()`,
    [sub.endpoint, playerId, sub.p256dh, sub.auth],
  );
  await pool.query(
    `DELETE FROM push_subscriptions WHERE player_id = $1 AND endpoint NOT IN (
       SELECT endpoint FROM push_subscriptions WHERE player_id = $1 ORDER BY created_at DESC LIMIT $2
     )`,
    [playerId, PUSH_PER_PLAYER],
  );
}

export async function removePushSubscription(playerId, endpoint) {
  await pool.query("DELETE FROM push_subscriptions WHERE player_id = $1 AND endpoint = $2", [playerId, endpoint]);
}

export async function dropPushEndpoint(endpoint) {
  await pool.query("DELETE FROM push_subscriptions WHERE endpoint = $1", [endpoint]);
}

export async function pushTargets(playerId) {
  const { rows } = await pool.query("SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE player_id = $1", [playerId]);
  return rows;
}

export async function claimPushMark(playerId, kind, minHours) {
  const { rows } = await pool.query(
    `INSERT INTO push_marks (player_id, kind) VALUES ($1, $2)
     ON CONFLICT (player_id, kind) DO UPDATE SET sent_at = now()
     WHERE push_marks.sent_at < now() - make_interval(hours => $3::int)
     RETURNING sent_at`,
    [playerId, kind, minHours],
  );
  return Boolean(rows[0]);
}

export async function idlePushPlayers(limit = 200) {
  const { rows } = await pool.query(
    `WITH subscribed AS (SELECT DISTINCT player_id FROM push_subscriptions),
     last_game AS (
       SELECT s.player_id, (SELECT max(played_at) FROM games g WHERE g.player_id = s.player_id) AS last
       FROM subscribed s
     )
     SELECT l.player_id FROM last_game l
     LEFT JOIN push_marks m ON m.player_id = l.player_id AND m.kind = 'idle'
     WHERE l.last IS NOT NULL AND l.last < now() - interval '48 hours'
       AND (m.sent_at IS NULL OR m.sent_at < l.last)
     LIMIT $1`,
    [limit],
  );
  return rows.map((row) => row.player_id);
}

export async function markIdlePushed(playerId) {
  await pool.query(
    `INSERT INTO push_marks (player_id, kind) VALUES ($1, 'idle')
     ON CONFLICT (player_id, kind) DO UPDATE SET sent_at = now()`,
    [playerId],
  );
}

export async function subscribedPlayers(limit = 500) {
  const { rows } = await pool.query("SELECT DISTINCT player_id FROM push_subscriptions LIMIT $1", [limit]);
  return rows.map((row) => row.player_id);
}

async function inTransaction(work) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function activeTourneyCode(client, playerId) {
  const { rows } = await client.query(
    `SELECT t.code FROM tournaments t
     JOIN tournament_players p ON p.tournament_id = t.id
     WHERE p.player_id = $1 AND t.status IN ('waiting', 'running')
     LIMIT 1`,
    [playerId],
  );
  return rows[0]?.code || "";
}

export async function activeTourneyOf(playerId) {
  return activeTourneyCode(pool, playerId);
}

export async function cancelStaleTourneys() {
  const { rows } = await pool.query(
    `UPDATE tournaments SET status = 'cancelled', finished_at = now()
     WHERE status = 'waiting'
       AND CASE
         WHEN NOT official THEN created_at < now() - interval '24 hours'
         WHEN starts_at IS NOT NULL THEN starts_at < now() - interval '1 day'
         ELSE created_at < now() - interval '7 days'
       END
     RETURNING code`,
  );
  return rows.map((row) => row.code);
}

export const OFFICIAL_OPEN_MINUTES = 10;

/** Temps laissé à chaque joueur pour arriver à son match de tournoi (4 min 30). */
export const TOURNEY_SHOW_UP_MS = Number(process.env.TOURNEY_SHOW_UP_MS) || 270_000;

function opensAt(startsAt) {
  return startsAt ? new Date(startsAt).getTime() - OFFICIAL_OPEN_MINUTES * 60_000 : 0;
}

export async function officialDueCodes() {
  const { rows } = await pool.query(
    `SELECT t.code
     FROM tournaments t
     JOIN tournament_players p ON p.tournament_id = t.id
     WHERE t.official AND t.status = 'waiting' AND t.starts_at IS NOT NULL AND t.starts_at <= now()
     GROUP BY t.id, t.code, t.size
     HAVING COUNT(*) = t.size`,
  );
  return rows.map((row) => row.code);
}

export async function deleteOfficial(code) {
  return inTransaction(async (client) => {
    const { rows } = await client.query("SELECT id, status, official FROM tournaments WHERE code = $1 FOR UPDATE", [code]);
    const tourney = rows[0];
    if (!tourney || !tourney.official) return { error: "unknown" };
    if (tourney.status === "running") return { error: "running" };
    if (tourney.status === "waiting") {
      await client.query("UPDATE tournaments SET status = 'cancelled', finished_at = now(), unlisted = true WHERE id = $1", [tourney.id]);
      return { ok: true, cancelled: true };
    }
    await client.query("UPDATE tournaments SET unlisted = true WHERE id = $1", [tourney.id]);
    return { ok: true, cancelled: false };
  });
}

export async function officialTourneys(viewerId, { all = false } = {}) {
  const { rows } = await pool.query(
    `SELECT t.code, t.name, t.size, t.status, t.created_at, t.starts_at,
       COUNT(p.player_id)::int AS players,
       COALESCE(bool_or(p.player_id = $1), false) AS you_in,
       w.name AS winner_name
     FROM tournaments t
     LEFT JOIN tournament_players p ON p.tournament_id = t.id
     LEFT JOIN profiles w ON w.id = t.winner_id
     WHERE t.official AND NOT t.unlisted
       AND (t.status IN ('waiting', 'running')
         OR (t.status = 'finished' AND t.finished_at > now() - interval '2 days')
         OR ($2 AND t.created_at > now() - interval '30 days'))
     GROUP BY t.id, w.name
     ORDER BY CASE t.status WHEN 'running' THEN 0 WHEN 'waiting' THEN 1 ELSE 2 END,
       CASE WHEN t.status = 'waiting' THEN COALESCE(t.starts_at, t.created_at) END ASC,
       COALESCE(t.finished_at, t.created_at) DESC
     LIMIT 30`,
    [viewerId || null, all],
  );
  return rows.map((row) => ({
    code: row.code,
    name: row.name,
    size: row.size,
    status: row.status,
    players: row.players,
    youIn: row.you_in,
    winner: row.winner_name || "",
    at: new Date(row.created_at).getTime(),
    startsAt: row.starts_at ? new Date(row.starts_at).getTime() : 0,
    opensAt: opensAt(row.starts_at),
  }));
}

export async function tourneyHistoryOf(playerId) {
  const { rows } = await pool.query(
    `SELECT t.code, t.name, t.status, t.size,
       COALESCE(t.finished_at, t.started_at, t.created_at) AS at,
       (SELECT COUNT(*)::int FROM tournament_players x WHERE x.tournament_id = t.id) AS players,
       w.name AS winner_name, (t.winner_id = $1) AS you_won
     FROM tournaments t
     JOIN tournament_players p ON p.tournament_id = t.id AND p.player_id = $1
     LEFT JOIN profiles w ON w.id = t.winner_id
     WHERE t.status <> 'cancelled'
     ORDER BY CASE WHEN t.status IN ('waiting', 'running') THEN 0 ELSE 1 END,
       COALESCE(t.finished_at, t.started_at, t.created_at) DESC
     LIMIT 30`,
    [playerId],
  );
  return rows.map((row) => ({
    code: row.code,
    name: row.name,
    status: row.status,
    size: row.size,
    players: row.players,
    at: new Date(row.at).getTime(),
    winner: row.winner_name || "",
    youWon: row.you_won === true,
  }));
}

export async function recentTourneyOf(playerId) {
  const { rows } = await pool.query(
    `SELECT t.code FROM tournaments t
     JOIN tournament_players p ON p.tournament_id = t.id
     WHERE p.player_id = $1 AND t.status = 'finished' AND t.finished_at > now() - interval '24 hours'
     ORDER BY t.finished_at DESC
     LIMIT 1`,
    [playerId],
  );
  return rows[0]?.code || "";
}

export async function createTourney({ creatorId, name, code, official = false, size = 4, startsAt = null }) {
  try {
    return await inTransaction(async (client) => {
      if (!official) {
        const active = await activeTourneyCode(client, creatorId);
        if (active) return { error: "active", code: active };
      }
      const { rows } = await client.query(
        "INSERT INTO tournaments (code, name, creator_id, official, size, starts_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
        [code, name, creatorId, official, size, startsAt],
      );
      if (!official) {
        await client.query("INSERT INTO tournament_players (tournament_id, player_id) VALUES ($1, $2)", [rows[0].id, creatorId]);
      }
      return { code };
    });
  } catch (error) {
    if (error.code === "23505") return { error: "code" };
    throw error;
  }
}

export async function joinTourney(code, playerId) {
  return inTransaction(async (client) => {
    const { rows } = await client.query(
      "SELECT id, size, status, official, creator_id, starts_at, (starts_at - make_interval(mins => $2)) > now() AS early FROM tournaments WHERE code = $1 FOR UPDATE",
      [code, OFFICIAL_OPEN_MINUTES],
    );
    const tourney = rows[0];
    if (!tourney) return { error: "unknown" };
    if (tourney.official && tourney.creator_id === playerId) return { error: "organizer" };
    const { rows: mine } = await client.query(
      "SELECT 1 FROM tournament_players WHERE tournament_id = $1 AND player_id = $2",
      [tourney.id, playerId],
    );
    if (mine[0]) return { ok: true, already: true };
    if (tourney.status !== "waiting") return { error: "started" };
    if (tourney.official && tourney.early) return { error: "early", opensAt: opensAt(tourney.starts_at) };
    const active = await activeTourneyCode(client, playerId);
    if (active) return { error: "active", code: active };
    const { rows: count } = await client.query("SELECT COUNT(*)::int AS n FROM tournament_players WHERE tournament_id = $1", [tourney.id]);
    if (count[0].n >= tourney.size) return { error: "full" };
    await client.query("INSERT INTO tournament_players (tournament_id, player_id) VALUES ($1, $2)", [tourney.id, playerId]);
    return { ok: true };
  });
}

export async function leaveTourney(code, playerId) {
  return inTransaction(async (client) => {
    const { rows } = await client.query("SELECT id, creator_id, status FROM tournaments WHERE code = $1 FOR UPDATE", [code]);
    const tourney = rows[0];
    if (!tourney) return { error: "unknown" };
    if (tourney.status !== "waiting") return { error: "started" };
    if (tourney.creator_id === playerId) {
      await client.query("UPDATE tournaments SET status = 'cancelled', finished_at = now() WHERE id = $1", [tourney.id]);
      return { ok: true, cancelled: true };
    }
    await client.query("DELETE FROM tournament_players WHERE tournament_id = $1 AND player_id = $2", [tourney.id, playerId]);
    return { ok: true };
  });
}

export async function launchTourney(code, playerId) {
  return inTransaction(async (client) => {
    const { rows } = await client.query("SELECT id, size, creator_id, status, official FROM tournaments WHERE code = $1 FOR UPDATE", [code]);
    const tourney = rows[0];
    if (!tourney) return { error: "unknown" };
    if (playerId ? tourney.creator_id !== playerId : !tourney.official) return { error: "creator" };
    if (tourney.status !== "waiting") return { error: "started" };
    const { rows: players } = await client.query("SELECT player_id FROM tournament_players WHERE tournament_id = $1", [tourney.id]);
    if (players.length !== tourney.size) return { error: "missing" };
    const order = players.map((row) => row.player_id);
    for (let i = order.length - 1; i > 0; i -= 1) {
      const j = randomInt(0, i + 1);
      [order[i], order[j]] = [order[j], order[i]];
    }
    for (const [seat, id] of order.entries()) {
      await client.query("UPDATE tournament_players SET seat = $3 WHERE tournament_id = $1 AND player_id = $2", [tourney.id, id, seat]);
    }
    const firstRound = order.length === 8 ? "quarter" : "semi";
    for (let slot = 0; slot < order.length / 2; slot += 1) {
      await client.query(
        "INSERT INTO tournament_matches (tournament_id, round, slot, p1, p2) VALUES ($1, $2, $3, $4, $5)",
        [tourney.id, firstRound, slot + 1, order[slot * 2], order[slot * 2 + 1]],
      );
    }
    if (firstRound === "quarter") {
      for (const slot of [1, 2]) {
        await client.query("INSERT INTO tournament_matches (tournament_id, round, slot) VALUES ($1, 'semi', $2)", [tourney.id, slot]);
      }
    }
    await client.query("INSERT INTO tournament_matches (tournament_id, round, slot) VALUES ($1, 'final', 1)", [tourney.id]);
    await client.query("UPDATE tournaments SET status = 'running', started_at = now() WHERE id = $1", [tourney.id]);
    return { ok: true };
  });
}

export async function tourneyMatchesToStart(code) {
  const { rows } = await pool.query(
    `SELECT m.id, m.round, m.slot, m.p1, m.p2, a.name AS p1_name, b.name AS p2_name
     FROM tournament_matches m
     JOIN tournaments t ON t.id = m.tournament_id
     JOIN profiles a ON a.id = m.p1
     JOIN profiles b ON b.id = m.p2
     WHERE t.code = $1 AND t.status = 'running' AND m.status = 'pending'
     ORDER BY m.slot`,
    [code],
  );
  return rows;
}

export async function markMatchPlaying(matchId, roomCode) {
  const { rows } = await pool.query(
    `UPDATE tournament_matches SET status = 'playing', room_code = $2, started_at = now()
     WHERE id = $1 AND status = 'pending' RETURNING id`,
    [matchId, roomCode],
  );
  return Boolean(rows[0]);
}

export async function finishMatch({ matchId, winner, scores, reason }) {
  const result = await inTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE tournament_matches SET status = 'done', winner = $2, scores = $3::text::jsonb, reason = $4, finished_at = now()
       WHERE id = $1 AND status = 'playing'
       RETURNING tournament_id, round, slot, p1, p2`,
      [matchId, winner, JSON.stringify(scores), reason],
    );
    const match = rows[0];
    if (!match) return null;
    const { rows: tourneys } = await client.query("SELECT code FROM tournaments WHERE id = $1 FOR UPDATE", [match.tournament_id]);
    const code = tourneys[0]?.code || "";
    const loser = winner === match.p1 ? match.p2 : match.p1;
    const nextRound = { quarter: "semi", semi: "final" }[match.round];
    if (nextRound) {
      const seat = match.slot % 2 === 1 ? "p1" : "p2";
      const { rows: next } = await client.query(
        `UPDATE tournament_matches SET ${seat} = $4
         WHERE tournament_id = $1 AND round = $2 AND slot = $3
         RETURNING p1, p2`,
        [match.tournament_id, nextRound, Math.ceil(match.slot / 2), winner],
      );
      const ready = Boolean(next[0]?.p1 && next[0]?.p2);
      return { code, round: match.round, nextRound, next: ready ? "start" : "wait", winner, loser };
    }
    const runnerUp = loser;
    await client.query(
      `UPDATE tournaments SET status = 'finished', winner_id = $2, runner_up_id = $3, finished_at = now()
       WHERE id = $1`,
      [match.tournament_id, winner, runnerUp],
    );
    return { code, round: "final", next: "done", winner, loser, runnerUp };
  });
  if (result?.next === "done") forgetRanking();
  return result;
}

export async function resetPlayingMatches() {
  await pool.query("UPDATE tournament_matches SET status = 'pending', room_code = NULL, started_at = NULL WHERE status = 'playing'");
  const { rows } = await pool.query("SELECT code FROM tournaments WHERE status = 'running'");
  return rows.map((row) => row.code);
}

export async function tourneyPeople(code) {
  const { rows } = await pool.query(
    `SELECT t.name AS tourney, t.creator_id, t.status, t.official, t.size, p.player_id, pr.name
     FROM tournaments t
     JOIN tournament_players p ON p.tournament_id = t.id
     JOIN profiles pr ON pr.id = p.player_id
     WHERE t.code = $1
     ORDER BY p.joined_at`,
    [code],
  );
  if (!rows[0]) return null;
  return {
    name: rows[0].tourney,
    creatorId: rows[0].creator_id,
    status: rows[0].status,
    official: rows[0].official,
    size: rows[0].size,
    players: rows.map((row) => ({ id: row.player_id, name: row.name })),
  };
}

export async function tourneyPlayerIds(code) {
  const { rows } = await pool.query(
    `SELECT p.player_id FROM tournament_players p JOIN tournaments t ON t.id = p.tournament_id WHERE t.code = $1`,
    [code],
  );
  return rows.map((row) => row.player_id);
}

export async function tourneyState(code, viewerId) {
  const { rows } = await pool.query(
    "SELECT id, code, name, size, creator_id, official, status, winner_id, runner_up_id, created_at, starts_at FROM tournaments WHERE code = $1",
    [code],
  );
  const tourney = rows[0];
  if (!tourney) return null;
  const { rows: players } = await pool.query(
    `SELECT p.player_id, p.seat, p.joined_at, pr.name, pr.photo, pr.public_id::text AS public_id
     FROM tournament_players p JOIN profiles pr ON pr.id = p.player_id
     WHERE p.tournament_id = $1 ORDER BY p.joined_at`,
    [tourney.id],
  );
  const { rows: matches } = await pool.query(
    `SELECT round, slot, p1, p2, status, winner, scores, reason, room_code, started_at FROM tournament_matches
     WHERE tournament_id = $1 ORDER BY CASE round WHEN 'quarter' THEN 0 WHEN 'semi' THEN 1 ELSE 2 END, slot`,
    [tourney.id],
  );
  const byId = new Map(players.map((row) => [row.player_id, row]));
  const view = (id) => {
    const row = byId.get(id);
    if (!row) return null;
    return { key: row.public_id, name: row.name, photo: row.photo, you: id === viewerId };
  };
  return {
    code: tourney.code,
    name: tourney.name,
    size: tourney.size,
    official: tourney.official,
    status: tourney.status,
    youIn: byId.has(viewerId),
    youCreator: !tourney.official && tourney.creator_id === viewerId,
    startsAt: tourney.starts_at ? new Date(tourney.starts_at).getTime() : 0,
    opensAt: opensAt(tourney.starts_at),
    players: players.map((row) => ({
      key: row.public_id,
      name: row.name,
      photo: row.photo,
      seat: row.seat,
      creator: row.player_id === tourney.creator_id,
      you: row.player_id === viewerId,
    })),
    matches: matches.map((row) => ({
      round: row.round,
      slot: row.slot,
      status: row.status,
      p1: view(row.p1),
      p2: view(row.p2),
      winner: row.winner ? view(row.winner)?.key || "" : "",
      scores: row.scores,
      reason: row.reason,
      mine: row.p1 === viewerId || row.p2 === viewerId,
      room: row.status === "playing" && (row.p1 === viewerId || row.p2 === viewerId) ? row.room_code || "" : "",
      showUpBy: row.status === "playing" && row.started_at ? new Date(row.started_at).getTime() + TOURNEY_SHOW_UP_MS : 0,
    })),
    winner: tourney.winner_id ? view(tourney.winner_id) : null,
  };
}

export async function hasGames(playerId) {
  const { rows } = await pool.query("SELECT EXISTS (SELECT 1 FROM games WHERE player_id = $1) AS found", [playerId]);
  return rows[0]?.found === true;
}

export async function clearGames(playerId) {
  await pool.query("DELETE FROM games WHERE player_id = $1", [playerId]);
  forgetRanking();
}

const ROBOT_GAMES = `
  SELECT g.difficulty, g.played_at, g.reason,
    CASE WHEN g.winner = g.user_seat::text THEN 'player'
         WHEN g.winner IN ('0', '1') THEN 'robot'
         ELSE 'draw' END AS result,
    CASE WHEN jsonb_typeof(g.scores) = 'array' AND (g.scores ->> 0) ~ '^[0-9]+$' THEN (g.scores ->> 0)::int END AS player_houses,
    CASE WHEN jsonb_typeof(g.scores) = 'array' AND (g.scores ->> 1) ~ '^[0-9]+$' THEN (g.scores ->> 1)::int END AS robot_houses
  FROM games g
  WHERE g.mode = 'solo' AND g.user_seat = 0
`;

export async function robotOverview() {
  const { rows: levels } = await pool.query(`
    SELECT COALESCE(difficulty, 'medium') AS difficulty,
      COUNT(*)::int AS games,
      COUNT(*) FILTER (WHERE result = 'robot')::int AS robot_wins,
      COUNT(*) FILTER (WHERE result = 'player')::int AS player_wins,
      COUNT(*) FILTER (WHERE result = 'draw')::int AS draws,
      COUNT(*) FILTER (WHERE reason = 'abandon')::int AS abandons,
      COALESCE(ROUND(AVG(player_houses), 1), 0)::float AS player_houses,
      COALESCE(ROUND(AVG(robot_houses), 1), 0)::float AS robot_houses
    FROM (${ROBOT_GAMES}) played
    GROUP BY 1
  `);
  const { rows: weeks } = await pool.query(`
    WITH series AS (
      SELECT generate_series(
        date_trunc('week', (now() AT TIME ZONE 'Europe/Paris')::date) - interval '7 weeks',
        date_trunc('week', (now() AT TIME ZONE 'Europe/Paris')::date),
        interval '1 week'
      )::date AS week
    ),
    played AS (
      SELECT date_trunc('week', (played_at AT TIME ZONE 'Europe/Paris')::date)::date AS week, result
      FROM (${ROBOT_GAMES}) g
      WHERE played_at >= now() - interval '9 weeks'
    )
    SELECT series.week::text AS week,
      COUNT(played.result)::int AS games,
      COUNT(*) FILTER (WHERE played.result = 'robot')::int AS robot_wins
    FROM series
    LEFT JOIN played USING (week)
    GROUP BY series.week
    ORDER BY series.week
  `);
  return {
    levels: levels.map((row) => ({
      difficulty: row.difficulty,
      games: row.games,
      robotWins: row.robot_wins,
      playerWins: row.player_wins,
      draws: row.draws,
      abandons: row.abandons,
      playerHouses: Number(row.player_houses) || 0,
      robotHouses: Number(row.robot_houses) || 0,
    })),
    weeks: weeks.map((row) => ({ week: row.week, games: row.games, robotWins: row.robot_wins })),
  };
}

export async function adminOverview() {
  const { rows: counts } = await pool.query(`
    SELECT
      (SELECT COUNT(*)::int FROM profiles) AS people,
      (SELECT COUNT(*)::int FROM profiles WHERE password_hash <> '') AS accounts,
      (SELECT COUNT(*)::int FROM games) AS games,
      (SELECT COUNT(*)::int FROM games WHERE mode = 'solo') AS solo,
      (SELECT COUNT(*)::int FROM games WHERE mode = 'local') AS local,
      (SELECT COUNT(*)::int FROM games WHERE mode = 'online') AS online_rows,
      (SELECT COUNT(*)::int FROM messages) AS messages
  `);
  const { rows: onlineRows } = await pool.query(`
    SELECT COUNT(*)::int AS online FROM (
      SELECT DISTINCT date_trunc('minute', played_at),
        CASE WHEN jsonb_typeof(names) = 'array'
          THEN (SELECT string_agg(lower(val), '|' ORDER BY lower(val)) FROM jsonb_array_elements_text(names) AS val)
          ELSE '' END
      FROM games WHERE mode = 'online'
    ) matches
  `);
  const { rows: days } = await pool.query(`
    WITH series AS (
      SELECT generate_series(
        ((now() AT TIME ZONE 'Europe/Paris')::date - 30),
        (now() AT TIME ZONE 'Europe/Paris')::date,
        interval '1 day'
      )::date AS day
    ),
    recent AS (
      SELECT (played_at AT TIME ZONE 'Europe/Paris')::date AS day, mode, played_at, names
      FROM games
      WHERE played_at >= ((SELECT min(day) FROM series)::timestamp AT TIME ZONE 'Europe/Paris')
    ),
    per_day AS (
      SELECT day, COUNT(*)::int AS games FROM recent GROUP BY day
    ),
    matches AS (
      SELECT day, COUNT(*)::int AS online FROM (
        SELECT DISTINCT day, date_trunc('minute', played_at),
          CASE WHEN jsonb_typeof(names) = 'array'
            THEN (SELECT string_agg(lower(val), '|' ORDER BY lower(val)) FROM jsonb_array_elements_text(names) AS val)
            ELSE '' END
        FROM recent
        WHERE mode = 'online'
      ) m
      GROUP BY day
    ),
    seen AS (
      SELECT day, COUNT(*)::int AS connected FROM visits
      WHERE day >= (SELECT min(day) FROM series)
      GROUP BY day
    )
    SELECT series.day::text AS day,
      COALESCE(seen.connected, 0) AS connected,
      COALESCE(per_day.games, 0) AS games,
      COALESCE(matches.online, 0) AS online
    FROM series
    LEFT JOIN seen USING (day)
    LEFT JOIN per_day USING (day)
    LEFT JOIN matches USING (day)
    ORDER BY series.day
  `);
  const { rows: reachRows } = await pool.query(`
    WITH today AS (
      SELECT (now() AT TIME ZONE 'Europe/Paris')::date AS day
    )
    SELECT
      (SELECT COUNT(*)::int FROM visits v, today t WHERE v.day = t.day) AS today,
      (SELECT COUNT(*)::int FROM visits v, today t WHERE v.day = t.day - 1) AS yesterday,
      (SELECT COUNT(DISTINCT v.player_id)::int FROM visits v, today t WHERE v.day BETWEEN t.day - 6 AND t.day) AS week,
      (SELECT COUNT(DISTINCT v.player_id)::int FROM visits v, today t
        WHERE v.day >= date_trunc('month', t.day)::date AND v.day <= t.day) AS month,
      (SELECT COUNT(DISTINCT v.player_id)::int FROM visits v, today t WHERE v.day BETWEEN t.day - 29 AND t.day) AS days30
  `);
  const { rows: players } = await pool.query(`
    SELECT p.name, p.email,
      COUNT(g.id)::int AS games,
      COALESCE(SUM(CASE WHEN g.mode = 'online' THEN 1 ELSE 0 END), 0)::int AS online,
      MAX(g.played_at) AS last_played
    FROM profiles p
    LEFT JOIN games g ON g.player_id = p.id
    GROUP BY p.id
    ORDER BY COUNT(g.id) DESC, p.created_at DESC
    LIMIT 80
  `);
  const { rows: notes } = await pool.query(`
    SELECT name, body, created_at FROM messages ORDER BY created_at DESC LIMIT 40
  `);
  const count = counts[0] || {};
  return {
    people: Number(count.people) || 0,
    accounts: Number(count.accounts) || 0,
    games: Number(count.games) || 0,
    solo: Number(count.solo) || 0,
    local: Number(count.local) || 0,
    onlineRows: Number(count.online_rows) || 0,
    online: Number(onlineRows[0]?.online) || 0,
    messages: Number(count.messages) || 0,
    reach: {
      today: Number(reachRows[0]?.today) || 0,
      yesterday: Number(reachRows[0]?.yesterday) || 0,
      week: Number(reachRows[0]?.week) || 0,
      month: Number(reachRows[0]?.month) || 0,
      days30: Number(reachRows[0]?.days30) || 0,
    },
    days: days.map((row) => ({
      day: row.day,
      connected: Number(row.connected) || 0,
      games: Number(row.games) || 0,
      online: Number(row.online) || 0,
    })),
    players: players.map((row) => ({
      name: row.name || "",
      email: row.email || "",
      games: Number(row.games) || 0,
      online: Number(row.online) || 0,
      lastPlayed: row.last_played ? new Date(row.last_played).toISOString() : "",
    })),
    notes: notes.map((row) => ({
      name: row.name || "",
      body: row.body || "",
      at: row.created_at ? new Date(row.created_at).toISOString() : "",
    })),
  };
}

export async function insertMessage({ name, body }) {
  await pool.query(
    "INSERT INTO messages (id, name, body) VALUES ($1, $2, $3)",
    [crypto.randomUUID(), name, body],
  );
}

export async function progressOf(playerId) {
  const { rows } = await pool.query(
    `WITH per_game AS (
       SELECT
         (CASE
            WHEN jsonb_typeof(g.scores) = 'array' THEN g.scores ->> g.user_seat
            ELSE g.scores ->> g.user_seat::text
          END)::int AS houses,
         CASE g.difficulty
           WHEN 'easy' THEN 7 WHEN 'medium' THEN 8 WHEN 'hard' THEN 9
           WHEN 'veryhard' THEN 10 WHEN 'expert' THEN 10 ELSE 8
         END AS per_house,
         CASE WHEN g.winner = g.user_seat::text THEN 15 ELSE 0 END AS win_bonus,
         g.duration_ms,
         g.clean,
         g.behind,
         g.difficulty,
         CASE
           WHEN jsonb_typeof(g.scores) = 'array' AND (g.scores ->> 1) ~ '^[0-9]+$' THEN (g.scores ->> 1)::int
           WHEN (g.scores ->> '1') ~ '^[0-9]+$' THEN (g.scores ->> '1')::int
           ELSE NULL
         END AS opp
       FROM games g
       WHERE g.player_id = $1
         AND g.mode = 'solo'
         AND g.user_seat = 0
         AND (CASE
            WHEN jsonb_typeof(g.scores) = 'array' THEN g.scores ->> g.user_seat
            ELSE g.scores ->> g.user_seat::text
          END) ~ '^[0-9]+$'
     )
     SELECT COALESCE(p.name, '') AS name,
       (COALESCE(SUM(15 + houses * per_house + win_bonus), 0)
        + COALESCE((SELECT
            (CASE WHEN bool_or(duration_ms BETWEEN 1000 AND 480000) THEN 40 ELSE 0 END)
            + (CASE WHEN bool_or(clean) THEN 50 ELSE 0 END)
            + (CASE WHEN bool_or(win_bonus > 0 AND houses >= 10) THEN 45 ELSE 0 END)
            + (CASE WHEN bool_or(behind AND win_bonus > 0) THEN 60 ELSE 0 END)
            + (CASE WHEN bool_or(difficulty = 'expert') THEN 35 ELSE 0 END)
            + (CASE WHEN bool_or(win_bonus > 0 AND opp = 0 AND houses > 0) THEN 55 ELSE 0 END)
          FROM per_game), 0)
        + COALESCE((
          WITH days AS (
            SELECT DISTINCT (played_at AT TIME ZONE 'Europe/Paris')::date AS day
            FROM games
            WHERE player_id = $1 AND mode = 'solo' AND user_seat = 0
          ),
          islands AS (
            SELECT day - (ROW_NUMBER() OVER (ORDER BY day))::int AS grp FROM days
          ),
          runs AS (SELECT COUNT(*)::int AS len FROM islands GROUP BY grp)
          SELECT COALESCE(MAX(CASE WHEN len >= 3 THEN 30 ELSE 0 END), 0)
               + COALESCE(MAX(CASE WHEN len >= 7 THEN 40 ELSE 0 END), 0)
          FROM runs
        ), 0))::int AS xp,
       COALESCE(SUM(houses), 0)::int AS houses,
       COALESCE(MAX(houses), 0)::int AS best,
       COUNT(houses)::int AS games,
       COALESCE(SUM(CASE WHEN win_bonus > 0 THEN 1 ELSE 0 END), 0)::int AS wins,
       COALESCE(SUM(CASE WHEN win_bonus > 0 AND difficulty = 'expert' THEN 1 ELSE 0 END), 0)::int AS expert_wins
     FROM (SELECT $1::uuid AS id) me
     LEFT JOIN profiles p ON p.id = me.id
     LEFT JOIN per_game ON true
     GROUP BY p.name`,
    [playerId],
  );
  const row = rows[0] || {};
  const online = await onlineTotals(playerId);
  return {
    name: row.name || "",
    xp: (Number(row.xp) || 0) + online.xp,
    houses: (Number(row.houses) || 0) + online.houses,
    best: Math.max(Number(row.best) || 0, online.best),
    games: (Number(row.games) || 0) + online.games,
    wins: (Number(row.wins) || 0) + online.wins,
    expertWins: Number(row.expert_wins) || 0,
  };
}

async function onlineTotals(playerId) {
  const { rows } = await pool.query(
    `SELECT
       COALESCE(SUM(15 + houses * 9 + win_bonus), 0)::int AS xp,
       COALESCE(SUM(houses), 0)::int AS houses,
       COALESCE(MAX(houses), 0)::int AS best,
       COUNT(houses)::int AS games,
       COALESCE(SUM(CASE WHEN win_bonus > 0 THEN 1 ELSE 0 END), 0)::int AS wins
     FROM (
       SELECT
         (CASE
            WHEN jsonb_typeof(scores) = 'array' THEN scores ->> user_seat
            ELSE scores ->> user_seat::text
          END)::int AS houses,
         CASE WHEN winner = user_seat::text THEN 15 ELSE 0 END AS win_bonus
       FROM games
       WHERE player_id = $1
         AND mode = 'online'
         AND user_seat IN (0, 1)
         AND (CASE
            WHEN jsonb_typeof(scores) = 'array' THEN scores ->> user_seat
            ELSE scores ->> user_seat::text
          END) ~ '^[0-9]+$'
     ) played`,
    [playerId],
  );
  const row = rows[0] || {};
  return {
    xp: (Number(row.xp) || 0) + (await tourneyXp(playerId)),
    houses: Number(row.houses) || 0,
    best: Number(row.best) || 0,
    games: Number(row.games) || 0,
    wins: Number(row.wins) || 0,
  };
}

const TOURNEY_WIN_XP = 150;
const TOURNEY_RUNNER_UP_XP = 100;

async function tourneyXp(playerId) {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(CASE WHEN winner_id = $1 THEN ${TOURNEY_WIN_XP} ELSE ${TOURNEY_RUNNER_UP_XP} END), 0)::int AS xp
     FROM tournaments
     WHERE status = 'finished' AND (winner_id = $1 OR runner_up_id = $1)`,
    [playerId],
  );
  return Number(rows[0]?.xp) || 0;
}

function packRank(rows) {
  return rows.map((row) => ({
    owner: row.owner,
    id: typeof row.id === "string" ? row.id : "",
    name: row.name,
    icon: row.icon,
    photo: typeof row.photo === "string" && row.photo.startsWith("https://res.cloudinary.com/ka4h4lpk/") ? row.photo : "",
    xp: row.xp,
    houses: row.houses,
    best: row.best,
    games: row.games,
    wins: row.wins,
    expertWins: row.expert_wins,
    rank: Number(row.rank),
    people: Number(row.people),
  }));
}

const RANK_TTL_MS = 60_000;
const rankCache = new Map();

export function forgetRanking() {
  rankCache.clear();
}

function rankRows(board) {
  const hit = rankCache.get(board);
  if (hit && Date.now() - hit.at < RANK_TTL_MS) return hit.rows;
  const rows = (board === "online" ? onlineRankRows() : generalRankRows()).catch((error) => {
    rankCache.delete(board);
    throw error;
  });
  rankCache.set(board, { at: Date.now(), rows });
  return rows;
}

export async function ranking(playerId, board = "general") {
  const rows = await rankRows(board === "online" ? "online" : "general");
  return rows.map(({ owner, ...row }) => ({ ...row, you: Boolean(playerId) && owner === playerId }));
}

async function generalRankRows() {
  const { rows } = await pool.query(
    `WITH per_game AS (
       SELECT g.player_id,
         (CASE
            WHEN jsonb_typeof(g.scores) = 'array' THEN g.scores ->> g.user_seat
            ELSE g.scores ->> g.user_seat::text
          END)::int AS houses,
         CASE g.difficulty
           WHEN 'easy' THEN 7
           WHEN 'medium' THEN 8
           WHEN 'hard' THEN 9
           WHEN 'veryhard' THEN 10
           WHEN 'expert' THEN 10
           ELSE 8
         END AS per_house,
         CASE WHEN g.winner = g.user_seat::text THEN 15 ELSE 0 END AS win_bonus,
         g.duration_ms,
         g.clean,
         g.behind,
         g.difficulty,
         CASE
           WHEN jsonb_typeof(g.scores) = 'array' AND (g.scores ->> 1) ~ '^[0-9]+$' THEN (g.scores ->> 1)::int
           WHEN (g.scores ->> '1') ~ '^[0-9]+$' THEN (g.scores ->> '1')::int
           ELSE NULL
         END AS opp
       FROM games g
       WHERE g.mode = 'solo'
         AND g.user_seat = 0
         AND (CASE
            WHEN jsonb_typeof(g.scores) = 'array' THEN g.scores ->> g.user_seat
            ELSE g.scores ->> g.user_seat::text
          END) ~ '^[0-9]+$'
     ),
     flag_xp AS (
       SELECT player_id,
         ((CASE WHEN bool_or(duration_ms BETWEEN 1000 AND 480000) THEN 40 ELSE 0 END)
          + (CASE WHEN bool_or(clean) THEN 50 ELSE 0 END)
          + (CASE WHEN bool_or(win_bonus > 0 AND houses >= 10) THEN 45 ELSE 0 END)
          + (CASE WHEN bool_or(behind AND win_bonus > 0) THEN 60 ELSE 0 END)
          + (CASE WHEN bool_or(difficulty = 'expert') THEN 35 ELSE 0 END)
          + (CASE WHEN bool_or(win_bonus > 0 AND opp = 0 AND houses > 0) THEN 55 ELSE 0 END))::int AS xp
       FROM per_game
       GROUP BY player_id
     ),
     days AS (
       SELECT player_id, (played_at AT TIME ZONE 'Europe/Paris')::date AS day
       FROM games
       WHERE mode = 'solo' AND user_seat = 0
       GROUP BY player_id, day
     ),
     islands AS (
       SELECT player_id, day - (ROW_NUMBER() OVER (PARTITION BY player_id ORDER BY day))::int AS grp
       FROM days
     ),
     streak_xp AS (
       SELECT player_id,
         (COALESCE(MAX(CASE WHEN len >= 3 THEN 30 ELSE 0 END), 0)
          + COALESCE(MAX(CASE WHEN len >= 7 THEN 40 ELSE 0 END), 0))::int AS xp
       FROM (SELECT player_id, COUNT(*)::int AS len FROM islands GROUP BY player_id, grp) runs
       GROUP BY player_id
     ),
     online_games AS (
       SELECT g.player_id,
         (CASE
            WHEN jsonb_typeof(g.scores) = 'array' THEN g.scores ->> g.user_seat
            ELSE g.scores ->> g.user_seat::text
          END)::int AS houses,
         CASE WHEN g.winner = g.user_seat::text THEN 15 ELSE 0 END AS win_bonus
       FROM games g
       WHERE g.mode = 'online'
         AND g.user_seat IN (0, 1)
         AND (CASE
            WHEN jsonb_typeof(g.scores) = 'array' THEN g.scores ->> g.user_seat
            ELSE g.scores ->> g.user_seat::text
          END) ~ '^[0-9]+$'
     ),
     online_xp AS (
       SELECT player_id,
         COALESCE(SUM(15 + houses * 9 + win_bonus), 0)::int AS xp,
         COALESCE(SUM(houses), 0)::int AS houses,
         COALESCE(MAX(houses), 0)::int AS best,
         COUNT(*)::int AS games,
         COALESCE(SUM(CASE WHEN win_bonus > 0 THEN 1 ELSE 0 END), 0)::int AS wins
       FROM online_games
       GROUP BY player_id
     ),
     tourney_xp AS (
       SELECT player_id, SUM(xp)::int AS xp
       FROM (
         SELECT winner_id AS player_id, ${TOURNEY_WIN_XP} AS xp FROM tournaments WHERE status = 'finished' AND winner_id IS NOT NULL
         UNION ALL
         SELECT runner_up_id, ${TOURNEY_RUNNER_UP_XP} FROM tournaments WHERE status = 'finished' AND runner_up_id IS NOT NULL
       ) won
       GROUP BY player_id
     ),
     scored AS (
       SELECT p.id, p.public_id, p.name, p.icon, COALESCE(p.photo, '') AS photo,
         (COALESCE(SUM(15 + pg.houses * pg.per_house + pg.win_bonus), 0)
          + COALESCE(MAX(flag_xp.xp), 0)
          + COALESCE(MAX(streak_xp.xp), 0)
          + COALESCE(MAX(ox.xp), 0)
          + COALESCE(MAX(tx.xp), 0))::int AS xp,
         (COALESCE(SUM(pg.houses), 0) + COALESCE(MAX(ox.houses), 0))::int AS houses,
         GREATEST(COALESCE(MAX(pg.houses), 0), COALESCE(MAX(ox.best), 0))::int AS best,
         (COUNT(pg.player_id) + COALESCE(MAX(ox.games), 0))::int AS games,
         (COALESCE(SUM(CASE WHEN pg.win_bonus > 0 THEN 1 ELSE 0 END), 0) + COALESCE(MAX(ox.wins), 0))::int AS wins,
         COALESCE(SUM(CASE WHEN pg.win_bonus > 0 AND pg.difficulty = 'expert' THEN 1 ELSE 0 END), 0)::int AS expert_wins
       FROM profiles p
       LEFT JOIN per_game pg ON pg.player_id = p.id
       LEFT JOIN flag_xp ON flag_xp.player_id = p.id
       LEFT JOIN streak_xp ON streak_xp.player_id = p.id
       LEFT JOIN online_xp ox ON ox.player_id = p.id
       LEFT JOIN tourney_xp tx ON tx.player_id = p.id
       GROUP BY p.id
     ),
     ranked AS (
       SELECT *, ROW_NUMBER() OVER (ORDER BY xp DESC, best DESC, games DESC, name) AS rank,
              COUNT(*) OVER () AS people
       FROM scored
     )
     SELECT id::text AS owner, public_id::text AS id, name, icon, photo, xp, houses, best, games, wins, expert_wins, rank, people
     FROM ranked
     ORDER BY rank`,
  );
  return packRank(rows);
}

async function onlineRankRows() {
  const { rows } = await pool.query(
    `WITH per_game AS (
       SELECT g.player_id,
         (CASE
            WHEN jsonb_typeof(g.scores) = 'array' THEN g.scores ->> g.user_seat
            ELSE g.scores ->> g.user_seat::text
          END)::int AS houses,
         CASE WHEN g.winner = g.user_seat::text THEN 15 ELSE 0 END AS win_bonus
       FROM games g
       WHERE g.mode = 'online'
         AND g.user_seat IN (0, 1)
         AND (CASE
            WHEN jsonb_typeof(g.scores) = 'array' THEN g.scores ->> g.user_seat
            ELSE g.scores ->> g.user_seat::text
          END) ~ '^[0-9]+$'
     ),
     tourney_xp AS (
       SELECT player_id, SUM(xp)::int AS xp
       FROM (
         SELECT winner_id AS player_id, ${TOURNEY_WIN_XP} AS xp FROM tournaments WHERE status = 'finished' AND winner_id IS NOT NULL
         UNION ALL
         SELECT runner_up_id, ${TOURNEY_RUNNER_UP_XP} FROM tournaments WHERE status = 'finished' AND runner_up_id IS NOT NULL
       ) won
       GROUP BY player_id
     ),
     scored AS (
       SELECT p.id, p.public_id, p.name, p.icon, COALESCE(p.photo, '') AS photo,
         (COALESCE(SUM(15 + houses * 9 + win_bonus), 0) + COALESCE(MAX(tx.xp), 0))::int AS xp,
         COALESCE(SUM(houses), 0)::int AS houses,
         COALESCE(MAX(houses), 0)::int AS best,
         COUNT(pg.player_id)::int AS games,
         COALESCE(SUM(CASE WHEN win_bonus > 0 THEN 1 ELSE 0 END), 0)::int AS wins,
         0::int AS expert_wins
       FROM profiles p
       LEFT JOIN per_game pg ON pg.player_id = p.id
       LEFT JOIN tourney_xp tx ON tx.player_id = p.id
       WHERE pg.player_id IS NOT NULL OR tx.player_id IS NOT NULL
       GROUP BY p.id
     ),
     ranked AS (
       SELECT *, ROW_NUMBER() OVER (ORDER BY xp DESC, best DESC, games DESC, name) AS rank,
              COUNT(*) OVER () AS people
       FROM scored
     )
     SELECT id::text AS owner, public_id::text AS id, name, icon, photo, xp, houses, best, games, wins, expert_wins, rank, people
     FROM ranked
     ORDER BY rank`,
  );
  return packRank(rows);
}

export async function playerCard(lookupId, viewerId) {
  const { rows: found } = await pool.query(
    "SELECT id FROM profiles WHERE public_id = $1 OR id = $1 LIMIT 1",
    [lookupId],
  );
  const targetId = found[0]?.id;
  if (!targetId) return null;
  const profile = await readProfile(targetId);
  if (!profile?.name) return null;
  const [general, online, together, stats] = await Promise.all([
    ranking(targetId, "general"),
    ranking(targetId, "online"),
    gamesTogether(viewerId, targetId),
    gameStats(targetId),
  ]);
  const mine = (rows) => rows.find((row) => row.you) || null;
  const g = mine(general);
  const o = mine(online);
  const photo = typeof profile.photo === "string" && profile.photo.startsWith("https://res.cloudinary.com/ka4h4lpk/") ? profile.photo : "";
  return {
    name: profile.name,
    self: Boolean(viewerId) && viewerId === targetId,
    photo,
    games: g?.games || 0,
    together,
    houses: g?.houses || 0,
    best: g?.best || 0,
    wins: g?.wins || 0,
    expertWins: g?.expertWins || 0,
    general: g ? { xp: g.xp, rank: g.rank, people: g.people } : null,
    online: o ? { xp: o.xp, rank: o.rank, people: o.people, games: o.games, wins: o.wins, houses: o.houses, best: o.best } : null,
    stats,
  };
}

async function gamesTogether(viewerId, targetId) {
  if (!isUuid(viewerId) || !isUuid(targetId) || viewerId === targetId) return 0;
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS games
     FROM games mine
     JOIN games theirs
       ON theirs.played_at = mine.played_at
      AND theirs.mode = 'online'
      AND mine.mode = 'online'
      AND theirs.player_id = $2
     WHERE mine.player_id = $1`,
    [viewerId, targetId],
  );
  return Number(rows[0]?.games) || 0;
}

/** Un compte par nom suivi (celui avec mot de passe en priorité). */
const NAME_KEY_SQL = "regexp_replace(translate(lower(trim(name)), 'àáâãäåçèéêëìíîïñòóôõöùúûüýÿ', 'aaaaaaceeeeiiiinooooouuuuyy'), '[[:space:]]+', ' ', 'g')";

export async function pinnedLearnWatch(names) {
  const wanted = [...new Set((names || []).map((name) => learnNameKey(name)).filter(Boolean))];
  if (!wanted.length || !pool) return [];
  const { rows: metaRows } = await pool.query("SELECT watch FROM learn_meta WHERE id = 1");
  const pinned = metaRows[0]?.watch && typeof metaRows[0].watch === "object" ? { ...metaRows[0].watch } : {};
  const missing = wanted.filter((name) => !isUuid(pinned[name]));
  if (missing.length) {
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (${NAME_KEY_SQL}) ${NAME_KEY_SQL} AS key, id::text AS id
       FROM profiles
       WHERE ${NAME_KEY_SQL} = ANY($1::text[]) AND password_hash <> ''
       ORDER BY ${NAME_KEY_SQL}, created_at ASC NULLS LAST, updated_at ASC`,
      [missing],
    );
    let changed = false;
    for (const row of rows) {
      if (isUuid(row.id)) {
        pinned[row.key] = row.id;
        changed = true;
      }
    }
    if (changed) {
      const kept = Object.fromEntries(wanted.filter((name) => isUuid(pinned[name])).map((name) => [name, pinned[name]]));
      await pool.query("UPDATE learn_meta SET watch = $1::text::jsonb, updated_at = now() WHERE id = 1", [JSON.stringify(kept)]);
    }
  }
  const ids = wanted.map((name) => pinned[name]).filter((id) => isUuid(id));
  if (!ids.length) return [];
  const { rows: alive } = await pool.query("SELECT id::text AS id, name FROM profiles WHERE id = ANY($1::uuid[])", [ids]);
  const byId = new Map(alive.map((row) => [row.id, row.name]));
  return wanted
    .filter((key) => byId.has(pinned[key]))
    .map((key) => ({ key, id: pinned[key], name: byId.get(pinned[key]) }));
}

export async function findLearnWatchIds(names) {
  return (await pinnedLearnWatch(names)).map((row) => row.id);
}

export async function insertLearnMatch(entry) {
  if (!pool || !entry?.id || !entry.fingerprint) return { ok: false, reason: "missing" };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const inserted = await client.query(
      `INSERT INTO learn_matches (
         id, fingerprint, room_code, player0_id, player1_id, player0_name, player1_name,
         started_at, ended_at, duration_ms, rows, cols, starter, scores, winner, reason, settings, move_count,
         opponent, difficulty
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7,
         to_timestamp($8 / 1000.0), to_timestamp($9 / 1000.0), $10, $11, $12, $13, $14::text::jsonb, $15, $16, $17::text::jsonb, $18,
         $19, $20
       )
       ON CONFLICT (fingerprint) DO NOTHING
       RETURNING id`,
      [
        entry.id,
        String(entry.fingerprint).slice(0, 200),
        String(entry.roomCode || "").slice(0, 24),
        entry.player0Id,
        entry.player1Id || null,
        String(entry.player0Name || "Joueur 1").slice(0, 40),
        String(entry.player1Name || "Joueur 2").slice(0, 40),
        Number(entry.startedAt) || Date.now(),
        Number(entry.endedAt) || Date.now(),
        Number.isInteger(entry.durationMs) ? entry.durationMs : null,
        Number(entry.rows) || 0,
        Number(entry.cols) || 0,
        entry.starter === 1 ? 1 : 0,
        jsonBody(entry.scores || [0, 0]),
        String(entry.winner ?? "draw").slice(0, 8),
        entry.reason ? String(entry.reason).slice(0, 24) : null,
        jsonBody(entry.settings || {}),
        Number(entry.moveCount) || 0,
        entry.opponent === "robot" ? "robot" : "online",
        entry.difficulty ? String(entry.difficulty).slice(0, 12) : null,
      ],
    );
    if (!inserted.rowCount) {
      await client.query("ROLLBACK");
      return { ok: true, duplicate: true };
    }
    const rows = (entry.moves || []).map((move) => ({
      step: Number(move.step) || 0,
      seat: move.seat === 1 ? 1 : 0,
      r: Number(move.r),
      c: Number(move.c),
      before: move.before || null,
      after: move.after || null,
      at: Number(move.at) || Date.now(),
    }));
    if (rows.length) {
      await client.query(
        `INSERT INTO learn_moves (match_id, step, seat, r, c, before_board, after_board, played_at)
         SELECT $1, x.step, x.seat, x.r, x.c, x.before, x.after, to_timestamp(x.at / 1000.0)
         FROM jsonb_to_recordset($2::text::jsonb)
           AS x(step int, seat int, r int, c int, before jsonb, after jsonb, at double precision)`,
        [entry.id, JSON.stringify(rows)],
      );
    }
    await client.query("COMMIT");
    return { ok: true, duplicate: false };
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    throw error;
  } finally {
    client.release();
  }
}

export async function getLearnMeta() {
  if (!pool) {
    return {
      activeVersion: "v1",
      candidateVersion: null,
      status: "indisponible",
      veryhardUsesCandidate: false,
      expertUsesCandidate: false,
      lastRunAt: null,
      lastError: "",
    };
  }
  const { rows } = await pool.query(
    `SELECT active_version, candidate_version, status, veryhard_candidate, expert_candidate, last_run_at, last_error
     FROM learn_meta WHERE id = 1`,
  );
  const row = rows[0] || {};
  return {
    activeVersion: row.active_version || "v1",
    candidateVersion: row.candidate_version || null,
    status: row.status || "pas commencé",
    veryhardUsesCandidate: row.veryhard_candidate === true,
    expertUsesCandidate: row.expert_candidate === true,
    lastRunAt: row.last_run_at ? new Date(row.last_run_at).toISOString() : null,
    lastError: row.last_error || "",
  };
}

export async function updateLearnMeta(patch = {}) {
  if (!pool) return getLearnMeta();
  const cur = await getLearnMeta();
  const next = {
    activeVersion: patch.activeVersion || cur.activeVersion || "v1",
    candidateVersion: patch.clearCandidate === true
      ? null
      : (patch.candidateVersion !== undefined ? patch.candidateVersion : cur.candidateVersion),
    status: patch.status || cur.status || "pas commencé",
    veryhardUsesCandidate: typeof patch.veryhardUsesCandidate === "boolean"
      ? patch.veryhardUsesCandidate
      : cur.veryhardUsesCandidate,
    expertUsesCandidate: typeof patch.expertUsesCandidate === "boolean"
      ? patch.expertUsesCandidate
      : cur.expertUsesCandidate,
    lastError: patch.lastError != null ? String(patch.lastError).slice(0, 400) : cur.lastError,
  };
  await pool.query(
    `UPDATE learn_meta SET
       active_version = $1,
       candidate_version = $2,
       status = $3,
       veryhard_candidate = $4,
       expert_candidate = $5,
       last_run_at = COALESCE($6::timestamptz, last_run_at),
       last_error = $7,
       updated_at = now()
     WHERE id = 1`,
    [
      next.activeVersion,
      next.candidateVersion,
      next.status,
      next.veryhardUsesCandidate,
      next.expertUsesCandidate,
      patch.lastRunAt || null,
      next.lastError || "",
    ],
  );
  return getLearnMeta();
}

export async function insertLearnRun(entry) {
  if (!pool) return null;
  const { rows } = await pool.query(
    `INSERT INTO learn_runs (kind, status, model_version, matches, moves, situations, report, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text::jsonb)
     RETURNING id::text AS id, created_at`,
    [
      String(entry.kind || "analyse").slice(0, 20),
      entry.status === "echec" ? "echec" : "ok",
      String(entry.modelVersion || "v1").slice(0, 24),
      Number(entry.matches) || 0,
      Number(entry.moves) || 0,
      Number(entry.situations) || 0,
      String(entry.report || "").slice(0, 4000),
      jsonBody(entry.detail || {}),
    ],
  );
  await pool.query(
    `UPDATE learn_meta SET last_run_at = now(), updated_at = now(),
       last_error = CASE WHEN $1 = 'echec' THEN $2 ELSE '' END
     WHERE id = 1`,
    [entry.status === "echec" ? "echec" : "ok", String(entry.report || entry.detail?.error || "").slice(0, 400)],
  );
  return rows[0] ? { id: rows[0].id, at: new Date(rows[0].created_at).toISOString() } : null;
}

export async function listLearnRuns(limit = 12) {
  if (!pool) return [];
  const { rows } = await pool.query(
    `SELECT id::text AS id, kind, status, model_version, matches, moves, situations, report, detail, created_at
     FROM learn_runs
     ORDER BY created_at DESC
     LIMIT $1`,
    [Math.max(1, Math.min(50, Number(limit) || 12))],
  );
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    status: row.status,
    modelVersion: row.model_version,
    matches: Number(row.matches) || 0,
    moves: Number(row.moves) || 0,
    situations: Number(row.situations) || 0,
    report: row.report || "",
    detail: row.detail || {},
    at: row.created_at ? new Date(row.created_at).toISOString() : null,
  }));
}

function deriveLearnStatus(matches, sitTotal, meta) {
  if (meta?.status === "echec") return "echec";
  if (meta?.status === "entrainement" || meta?.status === "validation" || meta?.status === "termine") {
    return meta.status;
  }
  if (sitTotal > 0) return "analyse";
  if (matches > 0) return "collecte";
  return "pas commencé";
}

export async function learnOverview() {
  if (!pool) {
    return {
      status: "indisponible",
      matches: 0,
      moves: 0,
      lastAt: null,
      recent: [],
      watch: [],
      situations: { total: 0, byKind: {}, byOutcome: { win: 0, loss: 0, draw: 0 }, analyzedMatches: 0 },
      model: await getLearnMeta(),
      runs: [],
      report: "Base indisponible.",
    };
  }
  const [counts, recent, watch, situations, meta, runs] = await Promise.all([
    pool.query(
      `SELECT COUNT(*)::int AS matches,
              COALESCE(SUM(move_count), 0)::int AS moves,
              MAX(ended_at) AS last_at
       FROM learn_matches`,
    ),
    pool.query(
      `SELECT id::text AS id, player0_name, player1_name, scores, winner, move_count,
              ended_at, duration_ms, rows, cols
       FROM learn_matches
       ORDER BY ended_at DESC
       LIMIT 12`,
    ),
    pinnedLearnWatch(LEARN_PEOPLE.map((person) => person.key)).then((rows) => ({ rows })),
    situationOverview(),
    getLearnMeta(),
    listLearnRuns(10),
  ]);
  const row = counts.rows[0] || {};
  const matches = Number(row.matches) || 0;
  const moves = Number(row.moves) || 0;
  const sitTotal = Number(situations.total) || 0;
  const status = deriveLearnStatus(matches, sitTotal, meta);
  if (status !== meta.status && status !== "echec") {
    await pool.query(`UPDATE learn_meta SET status = $1, updated_at = now() WHERE id = 1`, [status]);
    meta.status = status;
  }
  const overview = {
    status,
    matches,
    moves,
    lastAt: row.last_at ? new Date(row.last_at).toISOString() : null,
    recent: recent.rows.map((item) => ({
      id: item.id,
      names: [item.player0_name, item.player1_name],
      scores: item.scores,
      winner: item.winner,
      moves: Number(item.move_count) || 0,
      at: item.ended_at ? new Date(item.ended_at).toISOString() : null,
      durationMs: item.duration_ms,
      size: `${item.rows}×${item.cols}`,
    })),
    watch: LEARN_PEOPLE.map((person) => {
      const hit = watch.rows.find((item) => item.key === person.key);
      return { key: person.key, label: person.label, found: Boolean(hit), name: hit?.name || "" };
    }),
    situations,
    model: {
      ...meta,
      status,
    },
    runs,
  };
  overview.report = buildLearnReport(overview);
  return overview;
}

export async function getLearnMatch(id) {
  if (!pool || !isUuid(id)) return null;
  const { rows } = await pool.query(
    `SELECT id::text AS id, fingerprint, room_code, player0_id::text AS player0_id, player1_id::text AS player1_id,
            player0_name, player1_name, started_at, ended_at, duration_ms, rows, cols, starter,
            scores, winner, reason, settings, move_count
     FROM learn_matches WHERE id = $1`,
    [id],
  );
  const match = rows[0];
  if (!match) return null;
  const moves = await pool.query(
    `SELECT step, seat, r, c, before_board, after_board, played_at
     FROM learn_moves WHERE match_id = $1 ORDER BY step ASC`,
    [id],
  );
  return {
    id: match.id,
    fingerprint: match.fingerprint,
    roomCode: match.room_code,
    player0Id: match.player0_id,
    player1Id: match.player1_id,
    names: [match.player0_name, match.player1_name],
    startedAt: match.started_at ? new Date(match.started_at).toISOString() : null,
    endedAt: match.ended_at ? new Date(match.ended_at).toISOString() : null,
    durationMs: match.duration_ms,
    rows: match.rows,
    cols: match.cols,
    starter: match.starter,
    scores: match.scores,
    winner: match.winner,
    reason: match.reason,
    settings: match.settings || {},
    moveCount: Number(match.move_count) || 0,
    moves: moves.rows.map((move) => ({
      step: move.step,
      seat: move.seat,
      r: move.r,
      c: move.c,
      before: move.before_board,
      after: move.after_board,
      at: move.played_at ? new Date(move.played_at).toISOString() : null,
    })),
  };
}

export async function replaceLearnSituations(matchId, situations) {
  if (!pool || !isUuid(matchId)) return 0;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM learn_situations WHERE match_id = $1", [matchId]);
    let n = 0;
    for (const item of situations || []) {
      await client.query(
        `INSERT INTO learn_situations (match_id, step, kind, seat, outcome, size, detail)
         VALUES ($1, $2, $3, $4, $5, $6, $7::text::jsonb)
         ON CONFLICT (match_id, step, kind) DO NOTHING`,
        [
          matchId,
          Number(item.step) || 0,
          String(item.kind),
          item.seat === 1 ? 1 : 0,
          item.outcome === "win" || item.outcome === "loss" ? item.outcome : "draw",
          Number(item.size) || 0,
          jsonBody(item.detail || {}),
        ],
      );
      n += 1;
    }
    await client.query("COMMIT");
    return n;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    throw error;
  } finally {
    client.release();
  }
}

export async function listLearnMatchesNeedingAnalysis(limit = 40) {
  if (!pool) return [];
  const { rows } = await pool.query(
    `SELECT m.id::text AS id
     FROM learn_matches m
     LEFT JOIN learn_situations s ON s.match_id = m.id
     GROUP BY m.id
     HAVING COUNT(s.id) = 0
     ORDER BY m.ended_at DESC
     LIMIT $1`,
    [Math.max(1, Math.min(200, Number(limit) || 40))],
  );
  return rows.map((row) => row.id);
}

export async function situationOverview() {
  if (!pool) {
    return { total: 0, byKind: {}, byOutcome: { win: 0, loss: 0, draw: 0 }, analyzedMatches: 0 };
  }
  const [kinds, outcomes, analyzed] = await Promise.all([
    pool.query(`SELECT kind, COUNT(*)::int AS n FROM learn_situations GROUP BY kind`),
    pool.query(`SELECT outcome, COUNT(*)::int AS n FROM learn_situations GROUP BY outcome`),
    pool.query(`SELECT COUNT(DISTINCT match_id)::int AS n FROM learn_situations`),
  ]);
  const byKind = {};
  let total = 0;
  for (const row of kinds.rows) {
    byKind[row.kind] = Number(row.n) || 0;
    total += Number(row.n) || 0;
  }
  const byOutcome = { win: 0, loss: 0, draw: 0 };
  for (const row of outcomes.rows) {
    const key = row.outcome === "win" || row.outcome === "loss" ? row.outcome : "draw";
    byOutcome[key] += Number(row.n) || 0;
  }
  return {
    total,
    byKind,
    byOutcome,
    analyzedMatches: Number(analyzed.rows[0]?.n) || 0,
  };
}
