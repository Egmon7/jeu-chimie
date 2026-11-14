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
const pool = url ? new pg.Pool({ connectionString: url, max: 5 }) : null;
if (pool) pool.on("error", (error) => console.error("Base:", error.message));
let ready = false;

export function dbReady() {
  return ready;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value) {
  return UUID.test(String(value || ""));
}

export async function initDb() {
  if (!pool) return;
  await pool.query(`
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
  await pool.query("ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_email_check");
  await pool.query(`
    ALTER TABLE profiles ADD CONSTRAINT profiles_email_check
    CHECK (email = '' OR char_length(email) BETWEEN 3 AND 80)
  `);
  await pool.query("ALTER TABLE profiles ADD COLUMN IF NOT EXISTS icon text NOT NULL DEFAULT 'dot'");
  await pool.query("ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_icon_check");
  await pool.query(`
    ALTER TABLE profiles ADD CONSTRAINT profiles_icon_check
    CHECK (icon IN ('dot', 'house', 'star', 'crown', 'pen', 'book', 'flame', 'gem'))
  `);
  await pool.query("ALTER TABLE profiles ADD COLUMN IF NOT EXISTS photo text NOT NULL DEFAULT ''");
  await pool.query("ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_photo_check");
  await pool.query(`
    ALTER TABLE profiles ADD CONSTRAINT profiles_photo_check
    CHECK (photo = '' OR photo ~ '^https://res\\.cloudinary\\.com/ka4h4lpk/image/upload/[A-Za-z0-9_./%-]{1,360}$')
  `);
  ready = true;
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
  return rows[0];
}

export async function readProfile(id) {
  const { rows } = await pool.query("SELECT name, email, icon, photo FROM profiles WHERE id = $1", [id]);
  return rows[0] || null;
}

function winnerOut(value) {
  if (value === "draw") return "draw";
  const n = Number(value);
  return n === 0 || n === 1 ? n : "draw";
}

export async function insertGame(playerId, entry) {
  const winner = entry.winner === "draw" ? "draw" : String(entry.winner);
  await pool.query(
    `INSERT INTO games (id, player_id, played_at, mode, sheet, names, scores, winner, user_seat, reason, difficulty)
     VALUES ($1, $2, to_timestamp($3 / 1000.0), $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10, $11)
     ON CONFLICT (id) DO NOTHING`,
    [
      entry.id,
      playerId,
      Number(entry.at) || Date.now(),
      String(entry.mode || "solo").slice(0, 16),
      String(entry.size || "").slice(0, 16),
      JSON.stringify(entry.names || []),
      JSON.stringify(entry.scores || []),
      winner,
      entry.userSeat === 0 || entry.userSeat === 1 ? entry.userSeat : null,
      entry.reason ? String(entry.reason).slice(0, 24) : null,
      entry.difficulty ? String(entry.difficulty).slice(0, 16) : null,
    ],
  );
}

export async function listGames(playerId) {
  const { rows } = await pool.query(
    `SELECT id, played_at, mode, sheet, names, scores, winner, user_seat, reason, difficulty
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
  }));
}

export async function clearGames(playerId) {
  await pool.query("DELETE FROM games WHERE player_id = $1", [playerId]);
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
           WHEN 'easy' THEN 2 WHEN 'medium' THEN 3 WHEN 'hard' THEN 5
           WHEN 'veryhard' THEN 7 WHEN 'expert' THEN 10 ELSE 3
         END AS per_house,
         CASE WHEN g.winner = g.user_seat::text THEN 15 ELSE 0 END AS win_bonus
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
       COALESCE(SUM(20 + houses * per_house + win_bonus), 0)::int AS xp,
       COALESCE(SUM(houses), 0)::int AS houses,
       COALESCE(MAX(houses), 0)::int AS best,
       COUNT(houses)::int AS games,
       COALESCE(SUM(CASE WHEN win_bonus > 0 THEN 1 ELSE 0 END), 0)::int AS wins,
       COALESCE(SUM(CASE WHEN win_bonus > 0 AND per_house = 10 THEN 1 ELSE 0 END), 0)::int AS expert_wins
     FROM (SELECT $1::uuid AS id) me
     LEFT JOIN profiles p ON p.id = me.id
     LEFT JOIN per_game ON true
     GROUP BY p.name`,
    [playerId],
  );
  const row = rows[0] || {};
  return {
    name: row.name || "",
    xp: Number(row.xp) || 0,
    houses: Number(row.houses) || 0,
    best: Number(row.best) || 0,
    games: Number(row.games) || 0,
    wins: Number(row.wins) || 0,
    expertWins: Number(row.expert_wins) || 0,
  };
}

export async function ranking(playerId) {
  const { rows } = await pool.query(
    `WITH per_game AS (
       SELECT g.player_id,
         (CASE
            WHEN jsonb_typeof(g.scores) = 'array' THEN g.scores ->> g.user_seat
            ELSE g.scores ->> g.user_seat::text
          END)::int AS houses,
         CASE g.difficulty
           WHEN 'easy' THEN 2
           WHEN 'medium' THEN 3
           WHEN 'hard' THEN 5
           WHEN 'veryhard' THEN 7
           WHEN 'expert' THEN 10
           ELSE 3
         END AS per_house,
         CASE WHEN g.winner = g.user_seat::text THEN 15 ELSE 0 END AS win_bonus
       FROM games g
       WHERE g.mode = 'solo'
         AND g.user_seat = 0
         AND (CASE
            WHEN jsonb_typeof(g.scores) = 'array' THEN g.scores ->> g.user_seat
            ELSE g.scores ->> g.user_seat::text
          END) ~ '^[0-9]+$'
     ),
     scored AS (
       SELECT p.id, p.name, p.icon, COALESCE(p.photo, '') AS photo,
         COALESCE(SUM(20 + houses * per_house + win_bonus), 0)::int AS xp,
         COALESCE(SUM(houses), 0)::int AS houses,
         COALESCE(MAX(houses), 0)::int AS best,
         COUNT(pg.player_id)::int AS games,
         COALESCE(SUM(CASE WHEN win_bonus > 0 THEN 1 ELSE 0 END), 0)::int AS wins,
         COALESCE(SUM(CASE WHEN win_bonus > 0 AND per_house = 10 THEN 1 ELSE 0 END), 0)::int AS expert_wins
       FROM profiles p
       LEFT JOIN per_game pg ON pg.player_id = p.id
       GROUP BY p.id
     ),
     ranked AS (
       SELECT *, ROW_NUMBER() OVER (ORDER BY xp DESC, best DESC, games DESC, name) AS rank,
              COUNT(*) OVER () AS people
       FROM scored
     )
     SELECT name, icon, photo, xp, houses, best, games, wins, expert_wins, rank, people, (id = $1) AS you
     FROM ranked
     ORDER BY rank`,
    [playerId],
  );
  return rows.map((row) => ({
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
    you: row.you === true,
  }));
}
