import { createHash, randomBytes } from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";

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

export async function hasGames(playerId) {
  const { rows } = await pool.query("SELECT EXISTS (SELECT 1 FROM games WHERE player_id = $1) AS found", [playerId]);
  return rows[0]?.found === true;
}

export async function clearGames(playerId) {
  await pool.query("DELETE FROM games WHERE player_id = $1", [playerId]);
  forgetRanking();
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
    xp: Number(row.xp) || 0,
    houses: Number(row.houses) || 0,
    best: Number(row.best) || 0,
    games: Number(row.games) || 0,
    wins: Number(row.wins) || 0,
  };
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
     scored AS (
       SELECT p.id, p.public_id, p.name, p.icon, COALESCE(p.photo, '') AS photo,
         (COALESCE(SUM(15 + pg.houses * pg.per_house + pg.win_bonus), 0)
          + COALESCE(MAX(flag_xp.xp), 0)
          + COALESCE(MAX(streak_xp.xp), 0)
          + COALESCE(MAX(ox.xp), 0))::int AS xp,
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
     scored AS (
       SELECT p.id, p.public_id, p.name, p.icon, COALESCE(p.photo, '') AS photo,
         COALESCE(SUM(15 + houses * 9 + win_bonus), 0)::int AS xp,
         COALESCE(SUM(houses), 0)::int AS houses,
         COALESCE(MAX(houses), 0)::int AS best,
         COUNT(pg.player_id)::int AS games,
         COALESCE(SUM(CASE WHEN win_bonus > 0 THEN 1 ELSE 0 END), 0)::int AS wins,
         0::int AS expert_wins
       FROM profiles p
       JOIN per_game pg ON pg.player_id = p.id
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
