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
  await pool.query("ALTER TABLE games ADD COLUMN IF NOT EXISTS duration_ms integer");
  await pool.query("ALTER TABLE games ADD COLUMN IF NOT EXISTS behind boolean NOT NULL DEFAULT false");
  await pool.query("ALTER TABLE games ADD COLUMN IF NOT EXISTS clean boolean NOT NULL DEFAULT false");
  await pool.query("ALTER TABLE profiles ADD COLUMN IF NOT EXISTS password_hash text NOT NULL DEFAULT ''");
  try {
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS profiles_email_unique
      ON profiles (lower(email))
      WHERE email <> ''
    `);
  } catch (error) {
    console.error("Index e-mail:", error.message);
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash text PRIMARY KEY,
      player_id uuid NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await pool.query("CREATE INDEX IF NOT EXISTS sessions_player ON sessions (player_id)");
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
    return { profile: rows[0] };
  } catch (error) {
    if (error.code === "23505") return { error: "Cet e-mail a déjà un profil." };
    throw error;
  }
}

export async function replacePassword(email, passwordHash) {
  const account = await findAccount(email);
  if (!account?.password_hash) return { error: "Aucun mot de passe à remplacer." };
  const { rows } = await pool.query(
    `UPDATE profiles
     SET password_hash = $2, updated_at = now()
     WHERE id = $1 AND password_hash <> ''
     RETURNING id, name, email, icon, photo`,
    [account.id, passwordHash],
  );
  return rows[0] ? { profile: rows[0] } : { error: "Aucun mot de passe à remplacer." };
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
    "SELECT player_id FROM sessions WHERE token_hash = $1",
    [tokenHash(value)],
  );
  return rows[0]?.player_id || "";
}

function winnerOut(value) {
  if (value === "draw") return "draw";
  const n = Number(value);
  return n === 0 || n === 1 ? n : "draw";
}

export async function insertGame(playerId, entry) {
  const winner = entry.winner === "draw" ? "draw" : String(entry.winner);
  await pool.query(
    `INSERT INTO games (id, player_id, played_at, mode, sheet, names, scores, winner, user_seat, reason, difficulty, duration_ms, behind, clean)
     VALUES ($1, $2, to_timestamp($3 / 1000.0), $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10, $11, $12, $13, $14)
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
      Number.isInteger(entry.durationMs) ? entry.durationMs : null,
      entry.behind === true,
      entry.clean === true,
    ],
  );
}

export async function onlinePlay() {
  const { rows } = await pool.query(
    `SELECT player_id, played_at, names, user_seat
     FROM games
     WHERE mode = 'online'
     ORDER BY played_at DESC
     LIMIT 500`,
  );
  const matches = new Map();
  for (const row of rows) {
    const names = Array.isArray(row.names) ? row.names.map((name) => String(name || "").trim()).filter(Boolean) : [];
    const at = new Date(row.played_at).getTime();
    const key = `${names.map((name) => name.toLowerCase()).sort().join("|")}|${Math.floor(at / 60000)}`;
    if (!matches.has(key)) matches.set(key, []);
    matches.get(key).push({ ...row, names, at });
  }
  const people = new Map();
  for (const list of matches.values()) {
    const at = Math.min(...list.map((row) => row.at));
    const credited = new Set();
    const seen = new Set();
    for (const row of list) {
      const seat = row.user_seat === 0 || row.user_seat === 1 ? row.user_seat : 0;
      const own = row.names[seat] || row.names[0] || "Joueur";
      const id = row.player_id || `nom:${own.toLowerCase()}`;
      if (seen.has(id)) continue;
      seen.add(id);
      if (!people.has(id)) people.set(id, { name: own, games: 0, dates: [] });
      const person = people.get(id);
      person.name = own || person.name;
      person.games += 1;
      person.dates.push(at);
      credited.add(own.toLowerCase());
    }
    const mentioned = new Set(list.flatMap((row) => row.names));
    for (const name of mentioned) {
      if (credited.has(name.toLowerCase())) continue;
      const id = `nom:${name.toLowerCase()}`;
      if (!people.has(id)) people.set(id, { name, games: 0, dates: [] });
      people.get(id).games += 1;
      people.get(id).dates.push(at);
    }
  }
  const players = [...people.values()]
    .map((person) => ({
      name: person.name,
      games: person.games,
      dates: [...new Set(person.dates)].sort((a, b) => b - a).slice(0, 8),
    }))
    .sort((a, b) => b.games - a.games || a.name.localeCompare(b.name, "fr"));
  return { total: matches.size, players };
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
       (COALESCE(SUM(20 + houses * per_house + win_bonus), 0)
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
     scored AS (
       SELECT p.id, p.name, p.icon, COALESCE(p.photo, '') AS photo,
         (COALESCE(SUM(20 + houses * per_house + win_bonus), 0)
          + COALESCE(MAX(flag_xp.xp), 0)
          + COALESCE(MAX(streak_xp.xp), 0))::int AS xp,
         COALESCE(SUM(houses), 0)::int AS houses,
         COALESCE(MAX(houses), 0)::int AS best,
         COUNT(pg.player_id)::int AS games,
         COALESCE(SUM(CASE WHEN win_bonus > 0 THEN 1 ELSE 0 END), 0)::int AS wins,
         COALESCE(SUM(CASE WHEN win_bonus > 0 AND per_house = 10 THEN 1 ELSE 0 END), 0)::int AS expert_wins
       FROM profiles p
       LEFT JOIN per_game pg ON pg.player_id = p.id
       LEFT JOIN flag_xp ON flag_xp.player_id = p.id
       LEFT JOIN streak_xp ON streak_xp.player_id = p.id
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
