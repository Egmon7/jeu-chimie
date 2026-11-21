import express from "express";
import { createServer } from "http";
import { randomBytes, randomInt, randomUUID, scrypt, timingSafeEqual } from "crypto";
import { promisify } from "util";
import path from "path";
import { fileURLToPath } from "url";
import { Server } from "socket.io";
import {
  abandon,
  applyMove,
  cleanName,
  createGame,
  legalMoves,
  makeRoomCode,
  normalizeSettings,
  tick,
  REACTIONS,
} from "../public/js/engine.js";
import {
  clearGames,
  closeOtherSessions,
  closeSession,
  dbReady,
  emailTaken,
  findAccount,
  findByName,
  findLoginByName,
  passwordHashOf,
  hasGames,
  addNotification,
  listNotifications,
  readNotifications,
  onlineWinStreak,
  savePushSubscription,
  removePushSubscription,
  dropPushEndpoint,
  pushTargets,
  claimPushMark,
  idlePushPlayers,
  markIdlePushed,
  subscribedPlayers,
  initDb,
  insertGame,
  adminOverview,
  recordVisit,
  insertMessage,
  isUuid,
  listGames,
  gameStats,
  ranking,
  playerCard,
  progressOf,
  openSession,
  readProfile,
  saveAccount,
  saveResetCode,
  sessionPlayer,
  setOwnPassword,
  upsertProfile,
  useResetCode,
  SESSION_DAYS,
} from "./db.js";
import { mailReady, sendResetCode } from "./mail.js";
import { cleanSubscription, pushKey, pushReady, sendPush } from "./push.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  maxHttpBufferSize: 3_000_000,
  allowRequest(req, callback) {
    const origin = req.headers.origin;
    if (!origin) return callback(null, true);
    try {
      callback(null, new URL(origin).host === req.headers.host);
    } catch {
      callback(null, false);
    }
  },
});
const rooms = new Map();
const queue = new Map();
const presence = new Map();
const hits = new Map();
const connections = new Map();
const ROOM_LIMIT = 80;
const QUEUE_LIMIT = 80;
const CONNECTIONS_PER_IP = 120;
const WAITING_ROOM_MS = 20 * 60 * 1000;
const PLAY_GRACE_MS = 50_000;
const PHOTO_URL = /^https:\/\/res\.cloudinary\.com\/ka4h4lpk\/image\/upload\/[A-Za-z0-9_./%-]{1,360}$/;
const PEN_COLORS = ["red", "blue", "black", "green", "purple"];

app.disable("x-powered-by");
app.use("/api", (req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Content-Security-Policy", [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob: https://res.cloudinary.com",
    "media-src 'self' blob: data:",
    "connect-src 'self' https://api.cloudinary.com",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; "));
  next();
});
app.use(express.json({ limit: "8kb" }));
app.use(express.static(path.join(__dirname, "../public"), { dotfiles: "ignore" }));

function api(handler) {
  return (req, res) => {
    Promise.resolve(handler(req, res)).catch(() => {
      if (!res.headersSent) res.status(500).json({ error: "Base indisponible." });
    });
  };
}

function apiPlayer(req, res) {
  const id = String(req.params.id || "");
  if (!isUuid(id)) {
    res.status(400).json({ error: "Joueur inconnu." });
    return "";
  }
  if (!dbReady()) {
    res.status(503).json({ error: "Base indisponible." });
    return "";
  }
  if (ipLimited(clientIp(req), "api", 120, 60_000)) {
    res.status(429).json({ error: "Trop d'essais." });
    return "";
  }
  return id;
}

const scryptAsync = promisify(scrypt);
const SCRYPT_N = 65536;
const LEGACY_N = 16384;
const PASSWORD_MIN = 8;
const PASSWORD_RULE = `Le mot de passe doit avoir au moins ${PASSWORD_MIN} caractères.`;
const EMAIL_OK = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function cleanEmail(value) {
  return String(value || "").trim().toLowerCase().slice(0, 80);
}

function accountView(row) {
  return { found: true, many: false, exists: Boolean(row.password_hash) };
}

function accountOut(row) {
  return { id: row.id, name: row.name, email: row.email, icon: row.icon, photo: row.photo };
}

function scryptOptions(n) {
  return { N: n, r: 8, p: 1, maxmem: 160 * n * 8 };
}

async function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = await scryptAsync(password, salt, 32, scryptOptions(SCRYPT_N));
  return `scrypt$${SCRYPT_N}$${salt}$${hash.toString("hex")}`;
}

function parseHash(stored) {
  const value = String(stored || "");
  const modern = /^scrypt\$(\d+)\$([0-9a-f]{32})\$([0-9a-f]{64})$/i.exec(value);
  if (modern) return { n: Number(modern[1]), salt: modern[2], hex: modern[3] };
  const legacy = /^([0-9a-f]{32}):([0-9a-f]{64})$/i.exec(value);
  if (legacy) return { n: LEGACY_N, salt: legacy[1], hex: legacy[2] };
  return null;
}

async function currentPasswordOk(id, current) {
  const stored = await passwordHashOf(id);
  if (!stored) return true;
  const value = String(current || "");
  if (!value || value.length > 80) return false;
  return (await checkPassword(value, stored)).ok;
}

async function checkPassword(password, stored) {
  const parsed = parseHash(stored);
  if (!parsed || ![LEGACY_N, SCRYPT_N].includes(parsed.n)) return { ok: false, stale: false };
  const hash = await scryptAsync(password, parsed.salt, 32, scryptOptions(parsed.n));
  const ok = timingSafeEqual(Buffer.from(parsed.hex, "hex"), hash);
  return { ok, stale: ok && parsed.n !== SCRYPT_N };
}

function readCookie(req, name) {
  const raw = String(req.headers.cookie || "");
  for (const part of raw.split(";")) {
    const item = part.trim();
    if (!item.startsWith(`${name}=`)) continue;
    try {
      return decodeURIComponent(item.slice(name.length + 1));
    } catch {
      return "";
    }
  }
  return "";
}

function setSessionCookie(req, res, token) {
  const secure = req.secure || req.headers["x-forwarded-proto"] === "https";
  const age = token ? SESSION_DAYS * 24 * 60 * 60 : 0;
  res.setHeader("Set-Cookie", `egmon_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${age}${secure ? "; Secure" : ""}`);
}

function isAdminAccount(profile) {
  return String(profile?.email || "").trim().toLowerCase() === "egmonegmon340@gmail.com"
    && String(profile?.name || "").trim().toLowerCase() === "ntotimbe";
}

async function requireSession(req, res, playerId) {
  const owner = await sessionPlayer(readCookie(req, "egmon_session"));
  if (!owner || owner !== playerId) {
    res.status(401).json({ error: "Connexion requise." });
    return false;
  }
  return true;
}

app.post("/api/auth/lookup", api(async (req, res) => {
  if (!dbReady()) {
    res.status(503).json({ error: "Base indisponible." });
    return;
  }
  if (ipLimited(clientIp(req), "lookup", 20, 10 * 60_000)) {
    res.status(429).json({ error: "Trop d'essais." });
    return;
  }
  const key = String(req.body?.key || req.body?.email || "").trim().slice(0, 80);
  if (!key) {
    res.status(400).json({ error: "Écris un nom ou un e-mail." });
    return;
  }
  if (limited(`${key.toLowerCase()}:lookup`, 12, 15 * 60_000)) {
    res.status(429).json({ error: "Trop d'essais." });
    return;
  }
  if (EMAIL_OK.test(key)) {
    const account = await findAccount(cleanEmail(key));
    res.json(account ? accountView(account) : { found: false, exists: false });
    return;
  }
  const named = await findByName(key);
  if (named.length > 1) {
    res.json({ found: true, many: true, exists: false });
    return;
  }
  res.json(named[0] ? accountView(named[0]) : { found: false, exists: false });
}));

app.post("/api/auth/register", api(async (req, res) => {
  if (!dbReady()) {
    res.status(503).json({ error: "Base indisponible." });
    return;
  }
  if (ipLimited(clientIp(req), "register", 10, 10 * 60_000)) {
    res.status(429).json({ error: "Trop d'essais." });
    return;
  }
  const email = cleanEmail(req.body?.email);
  const name = String(req.body?.name || "").trim().slice(0, 40);
  const password = String(req.body?.password || "");
  const id = isUuid(req.body?.playerId) ? req.body.playerId : "";
  if (password.length < PASSWORD_MIN || password.length > 80) {
    res.status(400).json({ error: PASSWORD_RULE });
    return;
  }
  if (!name || !EMAIL_OK.test(email) || !id) {
    res.status(400).json({ error: "Nom, e-mail ou mot de passe invalide." });
    return;
  }
  const saved = await saveAccount({ id, name, email, passwordHash: await hashPassword(password) });
  if (saved.error) {
    res.status(409).json({ error: saved.error });
    return;
  }
  setSessionCookie(req, res, await openSession(saved.profile.id));
  notifyLater(saved.profile.id, {
    kind: "welcome",
    ref: "welcome",
    title: "Bienvenue sur Jeu - chimie",
    body: "Tes défis réussis et tes matchs en ligne arriveront ici.",
    link: "modes",
  });
  res.json(accountOut(saved.profile));
}));

app.post("/api/auth/login", api(async (req, res) => {
  if (!dbReady()) {
    res.status(503).json({ error: "Base indisponible." });
    return;
  }
  const key = String(req.body?.key || req.body?.email || "").trim().slice(0, 80);
  const password = String(req.body?.password || "");
  if (!key || password.length < 1 || password.length > 80) {
    res.status(400).json({ error: "Nom, e-mail ou mot de passe invalide." });
    return;
  }
  const byEmail = EMAIL_OK.test(key);
  const lookupKey = byEmail ? cleanEmail(key) : key.toLowerCase();
  if (ipLimited(clientIp(req), "login", 20, 10 * 60_000) || limited(`${lookupKey}:login`, 8, 15 * 60_000)) {
    res.status(429).json({ error: "Trop d'essais." });
    return;
  }
  const account = byEmail ? await findAccount(lookupKey) : await findLoginByName(key);
  const verdict = account?.password_hash
    ? await checkPassword(password, account.password_hash)
    : await hashPassword(password).then(() => ({ ok: false, stale: false }));
  if (!verdict.ok) {
    res.status(401).json({ error: "Mot de passe incorrect." });
    return;
  }
  if (verdict.stale) await setOwnPassword(account.id, await hashPassword(password));
  setSessionCookie(req, res, await openSession(account.id));
  res.json(accountOut(account));
}));

app.post("/api/auth/logout", api(async (req, res) => {
  const token = readCookie(req, "egmon_session");
  if (dbReady()) await closeSession(token);
  if (token) dropSockets((sock) => sock.data.sessionToken === token);
  setSessionCookie(req, res, "");
  res.json({ ok: true });
}));

app.post("/api/auth/reset", (req, res) => {
  res.status(410).json({ error: "Demande un code par e-mail pour changer de mot de passe." });
});

app.post("/api/auth/reset/request", api(async (req, res) => {
  if (!dbReady()) {
    res.status(503).json({ error: "Base indisponible." });
    return;
  }
  if (!mailReady()) {
    res.status(503).json({ error: "L'envoi des e-mails est indisponible pour le moment." });
    return;
  }
  const email = cleanEmail(req.body?.email);
  if (!EMAIL_OK.test(email)) {
    res.status(400).json({ error: "Cet e-mail n'est pas valide." });
    return;
  }
  if (ipLimited(clientIp(req), "reset-ask", 8, 10 * 60_000) || limited(`${email}:reset-ask`, 3, 15 * 60_000)) {
    res.status(429).json({ error: "Trop de demandes. Réessaie dans quelques minutes." });
    return;
  }
  res.json({ ok: true });
  const account = await findAccount(email);
  if (!account?.password_hash) return;
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await saveResetCode(account.id, code);
  sendResetCode(account.email, code).catch((error) => {
    console.error("Code de reset non envoyé:", error.message);
  });
}));

app.post("/api/auth/reset/confirm", api(async (req, res) => {
  if (!dbReady()) {
    res.status(503).json({ error: "Base indisponible." });
    return;
  }
  const email = cleanEmail(req.body?.email);
  const code = String(req.body?.code || "").replace(/\s/g, "");
  const password = String(req.body?.password || "");
  if (!EMAIL_OK.test(email) || !/^\d{6}$/.test(code)) {
    res.status(400).json({ error: "Code incorrect ou expiré." });
    return;
  }
  if (password.length < PASSWORD_MIN || password.length > 80) {
    res.status(400).json({ error: PASSWORD_RULE });
    return;
  }
  if (ipLimited(clientIp(req), "reset-code", 20, 10 * 60_000) || limited(`${email}:reset-code`, 10, 15 * 60_000)) {
    res.status(429).json({ error: "Trop d'essais. Réessaie dans quelques minutes." });
    return;
  }
  const account = await findAccount(email);
  if (!account?.password_hash || !(await useResetCode(account.id, code))) {
    res.status(400).json({ error: "Code incorrect ou expiré." });
    return;
  }
  await setOwnPassword(account.id, await hashPassword(password));
  await closeOtherSessions(account.id);
  dropSockets((sock) => sock.data.account === account.id);
  setSessionCookie(req, res, await openSession(account.id));
  res.json(accountOut(account));
}));

app.post("/api/auth/password", api(async (req, res) => {
  if (!dbReady()) {
    res.status(503).json({ error: "Base indisponible." });
    return;
  }
  const token = readCookie(req, "egmon_session");
  const id = await sessionPlayer(token);
  if (!id) {
    res.status(401).json({ error: "Connexion requise." });
    return;
  }
  const password = String(req.body?.password || "");
  const confirm = String(req.body?.confirm || "");
  if (password.length < PASSWORD_MIN || password.length > 80 || password !== confirm) {
    res.status(400).json({ error: `${PASSWORD_RULE} Écris-le deux fois.` });
    return;
  }
  if (limited(`${id}:password`, 8, 10 * 60_000)) {
    res.status(429).json({ error: "Trop d'essais." });
    return;
  }
  if (!(await currentPasswordOk(id, req.body?.current))) {
    res.status(403).json({ error: "Mot de passe actuel incorrect." });
    return;
  }
  const saved = await setOwnPassword(id, await hashPassword(password));
  if (!saved) {
    res.status(404).json({ error: "Profil introuvable." });
    return;
  }
  await closeOtherSessions(id, token);
  dropSockets((sock) => sock.data.account === id && sock.data.sessionToken !== token);
  res.json({ ok: true });
}));

app.get("/api/profile/:id", api(async (req, res) => {
  const id = apiPlayer(req, res);
  if (!id || !(await requireSession(req, res, id))) return;
  const profile = await readProfile(id);
  res.json(profile ? { ...profile, admin: isAdminAccount(profile) } : { name: "", email: "", admin: false });
}));

app.put("/api/profile/:id", api(async (req, res) => {
  const id = apiPlayer(req, res);
  if (!id || !(await requireSession(req, res, id))) return;
  const name = String(req.body?.name || "").trim().slice(0, 40);
  const email = cleanEmail(req.body?.email);
  if (!name || (email && !EMAIL_OK.test(email))) {
    res.status(400).json({ error: "Nom ou e-mail invalide." });
    return;
  }
  if (email && await emailTaken(email, id)) {
    res.status(409).json({ error: "Cet e-mail a déjà un profil." });
    return;
  }
  const before = await readProfile(id);
  if (before && cleanEmail(before.email) !== email) {
    if (limited(`${id}:email`, 8, 10 * 60_000)) {
      res.status(429).json({ error: "Trop d'essais." });
      return;
    }
    if (!(await currentPasswordOk(id, req.body?.current))) {
      res.status(403).json({ error: "Écris ton mot de passe actuel pour changer d'e-mail." });
      return;
    }
  }
  const icon = ["dot", "house", "star", "crown", "pen", "book", "flame", "gem"].includes(req.body?.icon)
    ? req.body.icon
    : null;
  const rawPhoto = String(req.body?.photo || "");
  const photo = /^https:\/\/res\.cloudinary\.com\/ka4h4lpk\/image\/upload\/[A-Za-z0-9_./%-]{1,360}$/.test(rawPhoto)
    ? rawPhoto
    : null;
  try {
    const saved = await upsertProfile({ id, name, email, icon, photo });
    res.json({ ...saved, admin: isAdminAccount(saved) });
  } catch (error) {
    if (error.code === "23505") {
      res.status(409).json({ error: "Cet e-mail a déjà un profil." });
      return;
    }
    throw error;
  }
}));

app.get("/api/ranking", api(async (req, res) => {
  if (!dbReady()) {
    res.status(503).json({ error: "Base indisponible." });
    return;
  }
  if (ipLimited(clientIp(req), "rank", 120, 60_000)) {
    res.status(429).json({ error: "Trop d'essais." });
    return;
  }
  const player = isUuid(req.query.player) ? req.query.player : null;
  const board = req.query.board === "online" ? "online" : "general";
  res.json(await ranking(player, board));
}));

app.get("/api/player-card", api(async (req, res) => {
  if (!dbReady()) {
    res.status(503).json({ error: "Base indisponible." });
    return;
  }
  if (ipLimited(clientIp(req), "rank", 120, 60_000)) {
    res.status(429).json({ error: "Trop d'essais." });
    return;
  }
  const id = isUuid(req.query.id) ? req.query.id : "";
  if (!id) {
    res.status(404).json({ error: "Profil introuvable." });
    return;
  }
  const viewer = isUuid(req.query.player) ? req.query.player : null;
  const card = await playerCard(id, viewer);
  if (!card) {
    res.status(404).json({ error: "Profil introuvable." });
    return;
  }
  res.json(card);
}));

app.get("/api/progress", api(async (req, res) => {
  if (!dbReady()) {
    res.status(503).json({ error: "Base indisponible." });
    return;
  }
  if (ipLimited(clientIp(req), "progress", 120, 60_000)) {
    res.status(429).json({ error: "Trop d'essais." });
    return;
  }
  const player = isUuid(req.query.player) ? req.query.player : null;
  if (!player) {
    res.json({ name: "", xp: 0, houses: 0, best: 0, games: 0, wins: 0, expertWins: 0 });
    return;
  }
  res.json(await progressOf(player));
}));

app.get("/api/admin", api(async (req, res) => {
  if (!dbReady()) {
    res.status(503).json({ error: "Base indisponible." });
    return;
  }
  const id = await sessionPlayer(readCookie(req, "egmon_session"));
  if (!id) {
    res.status(401).json({ error: "Connexion requise." });
    return;
  }
  if (limited(`${id}:admin`, 40, 60_000)) {
    res.status(429).json({ error: "Trop d'essais." });
    return;
  }
  const profile = await readProfile(id);
  if (!isAdminAccount(profile)) {
    res.status(403).json({ error: "Accès refusé." });
    return;
  }
  const overview = await adminOverview();
  res.json({ ...overview, live: liveSnapshot() });
}));

app.get("/api/games/:id", api(async (req, res) => {
  const id = apiPlayer(req, res);
  if (!id || !(await requireSession(req, res, id))) return;
  res.json({ games: await listGames(id), stats: await gameStats(id) });
}));

app.post("/api/games/:id", api(async (req, res) => {
  const id = apiPlayer(req, res);
  if (!id || !(await requireSession(req, res, id))) return;
  const entry = validGame(req.body);
  if (!entry) {
    res.status(400).json({ error: "Partie invalide." });
    return;
  }
  if (entry.mode === "online") {
    res.json({ ok: true });
    return;
  }
  if (limited(`${id}:game`, 30, 60 * 60 * 1000)) {
    res.status(429).json({ error: "Trop de parties enregistrées." });
    return;
  }
  if (entry.at < Date.now() - 48 * 60 * 60 * 1000 && await hasGames(id)) entry.at = Date.now();
  await insertGame(id, entry);
  res.json({ ok: true });
}));

app.post("/api/messages", api(async (req, res) => {
  if (!dbReady()) {
    res.status(503).json({ error: "Base indisponible." });
    return;
  }
  if (ipLimited(clientIp(req), "message", 30, 60 * 60 * 1000)) {
    res.status(429).json({ error: "Trop de messages." });
    return;
  }
  const name = String(req.body?.name || "").trim().slice(0, 40);
  const body = String(req.body?.message || "").trim().slice(0, 800);
  if (!name || !body) {
    res.status(400).json({ error: "Écris ton nom et ton message." });
    return;
  }
  await insertMessage({ name, body });
  res.json({ ok: true });
}));

async function sessionAccount(req, res) {
  if (!dbReady()) {
    res.status(503).json({ error: "Base indisponible." });
    return "";
  }
  const id = await sessionPlayer(readCookie(req, "egmon_session"));
  if (!id) {
    res.status(401).json({ error: "Connexion requise." });
    return "";
  }
  if (limited(`${id}:notes`, 60, 60_000)) {
    res.status(429).json({ error: "Trop d'essais." });
    return "";
  }
  return id;
}

app.get("/api/notifications", api(async (req, res) => {
  const id = await sessionAccount(req, res);
  if (id) res.json(await listNotifications(id));
}));

app.post("/api/notifications/read", api(async (req, res) => {
  const id = await sessionAccount(req, res);
  if (!id) return;
  await readNotifications(id);
  res.json({ ok: true });
}));

app.get("/api/push/key", (req, res) => {
  res.json({ key: pushReady() ? pushKey() : "" });
});

app.post("/api/push/subscribe", api(async (req, res) => {
  const id = await sessionAccount(req, res);
  if (!id) return;
  if (!pushReady()) {
    res.status(503).json({ error: "Alertes indisponibles." });
    return;
  }
  const sub = cleanSubscription(req.body);
  if (!sub) {
    res.status(400).json({ error: "Abonnement invalide." });
    return;
  }
  await savePushSubscription(id, sub);
  res.json({ ok: true });
}));

app.post("/api/push/unsubscribe", api(async (req, res) => {
  const id = await sessionAccount(req, res);
  if (!id) return;
  const endpoint = String(req.body?.endpoint || "").slice(0, 1000);
  if (endpoint) await removePushSubscription(id, endpoint);
  res.json({ ok: true });
}));

app.post("/api/notifications/challenge", api(async (req, res) => {
  const id = await sessionAccount(req, res);
  if (!id) return;
  const challenge = String(req.body?.id || "");
  const name = Object.hasOwn(CHALLENGE_NAMES, challenge) ? CHALLENGE_NAMES[challenge] : "";
  if (!name) {
    res.status(400).json({ error: "Défi inconnu." });
    return;
  }
  await notify(id, {
    kind: "challenge",
    ref: challenge,
    title: `Défi réussi : ${name}`,
    body: "Les XP du défi sont ajoutés à ta progression.",
    link: "challenges",
  });
  res.json({ ok: true });
}));

app.delete("/api/games/:id", api(async (req, res) => {
  const id = apiPlayer(req, res);
  if (!id || !(await requireSession(req, res, id))) return;
  await clearGames(id);
  res.json({ ok: true });
}));

function roomCode(value) {
  const code = String(value || "").trim().toUpperCase();
  return /^EGD-[A-Z2-9]{6}$/.test(code) ? code : "";
}

function safePlayerId(value, fallback) {
  const id = String(value || "");
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) return id;
  return fallback;
}

function playerKey(socket, value) {
  if (socket.data.account) return socket.data.account;
  return `guest:${safePlayerId(value, socket.id)}`;
}

function asMove(move) {
  if (!move || typeof move !== "object") return null;
  const { r, c } = move;
  if (!Number.isInteger(r) || !Number.isInteger(c)) return null;
  if (r < 0 || c < 0 || r > 32 || c > 32) return null;
  return { r, c };
}

function limited(key, max, windowMs) {
  const now = Date.now();
  const fresh = (hits.get(key) || []).filter((time) => now - time < windowMs);
  if (fresh.length >= max) {
    hits.set(key, fresh);
    return true;
  }
  fresh.push(now);
  hits.set(key, fresh);
  return false;
}

function lastForwarded(header) {
  const parts = String(header || "").split(",").map((part) => part.trim()).filter(Boolean);
  const last = (parts[parts.length - 1] || "").replace(/^::ffff:/, "");
  if (last.length < 3 || last.length > 64) return "";
  if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(last) && !/^[0-9a-f:]+$/i.test(last)) return "";
  return last;
}

function isPrivate(ip) {
  return ip === "127.0.0.1"
    || ip === "::1"
    || ip.startsWith("10.")
    || ip.startsWith("192.168.")
    || /^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)
    || ip.startsWith("fc")
    || ip.startsWith("fd");
}

function clientIp(req) {
  const peer = String(req.socket?.remoteAddress || "").replace(/^::ffff:/, "");
  const forwarded = lastForwarded(req.headers?.["x-forwarded-for"]);
  if (isPrivate(peer) && forwarded) return forwarded;
  return peer || "unknown";
}

function publicIp(ip) {
  if (!ip || ip === "unknown" || isPrivate(ip)) return "";
  return ip;
}

function ipLimited(ip, label, max, windowMs) {
  const key = publicIp(ip);
  if (!key) return false;
  return limited(`${key}:${label}`, max, windowMs);
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function queueToken(value) {
  const token = String(value || "");
  return /^[A-Z2-9]{6}$/.test(token) ? token : "";
}

const GAME_REASONS = ["board", "score", "time", "abandon", "robot"];

function sheetOf(value) {
  const match = String(value || "").match(/^(\d{1,2})[x×](\d{1,2})$/);
  if (!match) return null;
  const rows = Number(match[1]);
  const cols = Number(match[2]);
  if (rows < 2 || rows > 32 || cols < 2 || cols > 32) return null;
  return { rows, cols, size: `${rows}×${cols}` };
}

function validGame(entry) {
  if (!entry || typeof entry !== "object" || !isUuid(entry.id)) return null;
  if (!["solo", "local", "online"].includes(entry.mode)) return null;
  if (!Array.isArray(entry.names) || !Array.isArray(entry.scores) || entry.scores.length < 2) return null;
  const sheet = sheetOf(entry.size);
  if (!sheet) return null;
  const reason = entry.reason == null || entry.reason === "" ? null : entry.reason;
  if (reason !== null && !GAME_REASONS.includes(reason)) return null;
  const ceiling = Math.min(42, Math.floor(((sheet.rows + 1) * (sheet.cols + 1)) / 2));
  const scores = entry.scores.slice(0, 2).map((score) => {
    const n = Number(score);
    return Number.isInteger(n) && n >= 0 && n <= ceiling ? n : -1;
  });
  if (scores.some((score) => score < 0)) return null;
  if (scores[0] + scores[1] > Math.floor(((sheet.rows + 1) * (sheet.cols + 1)) / 2)) return null;
  const winner = entry.winner === 0 || entry.winner === 1 || entry.winner === "draw" ? entry.winner : "draw";
  if (reason === "board" || reason === "score") {
    const expected = scores[0] > scores[1] ? 0 : scores[1] > scores[0] ? 1 : "draw";
    if (winner !== expected) return null;
  }
  const at = Number(entry.at);
  return {
    id: entry.id,
    at: Number.isFinite(at) ? Math.min(Date.now() + 60_000, Math.max(0, at)) : Date.now(),
    mode: entry.mode,
    size: sheet.size,
    names: entry.names.slice(0, 2).map((name) => cleanName(name, "Joueur")),
    scores,
    durationMs: Number.isInteger(Number(entry.durationMs)) && Number(entry.durationMs) > 0 && Number(entry.durationMs) < 6 * 60 * 60 * 1000 ? Number(entry.durationMs) : null,
    behind: entry.behind === true,
    clean: entry.clean === true,
    winner,
    userSeat: entry.userSeat === 0 || entry.userSeat === 1 ? entry.userSeat : null,
    reason,
    difficulty: ["easy", "medium", "hard", "veryhard", "expert"].includes(entry.difficulty) ? entry.difficulty : null,
  };
}

io.use((socket, next) => {
  const ip = clientIp(socket.request);
  socket.data.ip = ip;
  const real = publicIp(ip);
  if (!real) return next();
  const count = connections.get(real) || 0;
  if (count >= CONNECTIONS_PER_IP) return next(new Error("Trop de connexions."));
  connections.set(real, count + 1);
  socket.on("disconnect", () => {
    const left = (connections.get(real) || 1) - 1;
    if (left <= 0) connections.delete(real);
    else connections.set(real, left);
  });
  next();
});

io.use(async (socket, next) => {
  socket.data.account = "";
  socket.data.sessionToken = "";
  if (dbReady()) {
    try {
      const token = readCookie(socket.request, "egmon_session");
      socket.data.account = await sessionPlayer(token);
      if (socket.data.account) socket.data.sessionToken = token;
    } catch {
      socket.data.account = "";
    }
  }
  next();
});

const CHALLENGE_NAMES = {
  speed: "Moins de 8 minutes",
  precision: "Précision",
  dominate: "Domination",
  comeback: "Remontée",
  streak: "Série de 3 jours",
  expert: "Expert",
  blank: "Feuille blanche",
  week: "Série de 7 jours",
};

async function notify(playerId, note) {
  if (!isUuid(playerId) || !dbReady()) return null;
  const saved = await addNotification({ playerId, ...note });
  if (!saved) return null;
  for (const sock of io.sockets.sockets.values()) {
    if (sock.data.account === playerId) sock.emit("notify", saved);
  }
  return saved;
}

async function pushTo(playerId, message) {
  if (!pushReady() || !isUuid(playerId)) return 0;
  let sent = 0;
  for (const sub of await pushTargets(playerId)) {
    const result = await sendPush(sub, message);
    if (result.ok) sent += 1;
    else if (result.gone) await dropPushEndpoint(sub.endpoint);
  }
  return sent;
}

function accountOnline(playerId) {
  for (const sock of io.sockets.sockets.values()) {
    if (sock.data.account === playerId) return true;
  }
  return false;
}

function freePeopleCount() {
  return findPeople(null).filter((person) => !person.busy).length;
}

async function pushIdlePlayers() {
  for (const playerId of await idlePushPlayers()) {
    if (accountOnline(playerId)) continue;
    await markIdlePushed(playerId);
    await pushTo(playerId, {
      title: "Tu t'ennuies ?",
      body: "Une feuille t'attend. Clique pour jouer.",
      url: "/",
      tag: "idle",
    });
  }
}

async function pushFreePlayers() {
  const free = freePeopleCount();
  if (free <= 5) return;
  for (const playerId of await subscribedPlayers()) {
    if (accountOnline(playerId)) continue;
    if (!(await claimPushMark(playerId, "free", 24))) continue;
    await pushTo(playerId, {
      title: `${free} joueurs sont libres`,
      body: "C'est le bon moment pour une partie en ligne.",
      url: "/",
      tag: "free",
    });
  }
}

function pushRounds() {
  if (!dbReady() || !pushReady()) return;
  pushIdlePlayers().catch((error) => console.error("Alertes inactivité:", error.message));
  pushFreePlayers().catch((error) => console.error("Alertes joueurs libres:", error.message));
}

setInterval(pushRounds, 10 * 60 * 1000).unref();

function notifyLater(playerId, note) {
  notify(playerId, note).catch((error) => console.error("Notification:", error.message));
}

function dropSockets(match) {
  for (const sock of io.sockets.sockets.values()) {
    if (sock.data.account && match(sock)) sock.disconnect(true);
  }
}

function seatOf(room, playerId) {
  return room.players.findIndex((player) => player && player.id === playerId);
}

function snapshot(room, event = null) {
  return {
    code: room.code,
    settings: room.settings,
    game: room.game,
    seats: room.players.map((player, index) => (
      player
        ? {
          name: player.name,
          color: player.color,
          connected: player.connected,
          present: true,
          forfeitAt: player.connected === false ? (room.forfeitAt?.[index] || null) : null,
        }
        : { present: false, connected: false, name: "", color: "", forfeitAt: null }
    )),
    rematch: room.rematch.slice(),
    ready: room.ready?.slice() || [false, false],
    accepted: room.accepted === true,
    direct: room.direct === true,
    event,
  };
}

function matchNote(seat, names, scores, winner, reason) {
  const foe = names[1 - seat];
  const score = `${scores[seat]} – ${scores[1 - seat]}`;
  const outcome = winner === "draw" ? "égalité" : winner === seat ? "gagné" : "perdu";
  const won = winner === seat;
  const why = {
    abandon: won ? `${foe} a abandonné.` : "Tu as abandonné.",
    time: "Fin au temps.",
    score: "Objectif de maisons atteint.",
    board: "Feuille pleine.",
  }[reason] || "";
  return {
    kind: "match",
    title: `Match contre ${foe} : ${outcome} ${score}`,
    body: why,
    link: "history",
  };
}

function celebrateStreak(playerId) {
  onlineWinStreak(playerId).then(async ({ streak, last }) => {
    if (streak !== 3) return;
    const saved = await notify(playerId, {
      kind: "streak",
      ref: `streak3:${last}`,
      title: "3 victoires en ligne d'affilée",
      body: "Bravo ! Regarde ta place dans le classement en ligne.",
      link: "rank-online",
    });
    if (saved && !accountOnline(playerId)) {
      await pushTo(playerId, { title: "3 victoires d'affilée !", body: "Bravo ! Viens voir ta place au classement.", url: "/", tag: "streak" });
    }
  }).catch((error) => console.error("Série:", error.message));
}

function saveOnlineMatch(room) {
  const game = room.game;
  if (!game || game.status !== "finished" || room.saved || room.saving) return;
  room.saving = true;
  const at = Date.now();
  const duration = room.startedAt ? Math.max(1, Math.round(at - room.startedAt)) : null;
  const names = [0, 1].map((seat) => cleanName(room.players[seat]?.name, `Joueur ${seat + 1}`));
  const scores = [0, 1].map((seat) => {
    const n = Number(game.scores?.[seat]);
    return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
  });
  const winner = game.winner === 0 || game.winner === 1 || game.winner === "0" || game.winner === "1"
    ? Number(game.winner)
    : "draw";
  Promise.all([0, 1].map((seat) => {
    const player = room.players[seat];
    if (!isUuid(player?.id)) return null;
    return insertGame(player.id, {
      id: randomUUID(),
      at,
      mode: "online",
      size: `${Number(game.rows) || 0}x${Number(game.cols) || 0}`,
      names,
      scores,
      winner,
      userSeat: seat,
      reason: game.reason ? String(game.reason).slice(0, 24) : null,
      difficulty: null,
      durationMs: Number.isInteger(duration) ? duration : null,
      behind: false,
      clean: false,
    });
  })).then(() => {
    room.saved = true;
    for (const seat of [0, 1]) {
      const player = room.players[seat];
      if (!isUuid(player?.id)) continue;
      notifyLater(player.id, matchNote(seat, names, scores, winner, game.reason));
      if (winner === seat) celebrateStreak(player.id);
    }
  }).catch((error) => {
    console.error("Partie en ligne non enregistrée:", error.message);
    room.saved = false;
  }).finally(() => {
    room.saving = false;
  });
}

function emitState(room, event = null) {
  room.touched = Date.now();
  if (room.game?.status === "finished") saveOnlineMatch(room);
  const paired = pairState(room);
  if (room.listed !== paired) {
    room.listed = paired;
    setImmediate(broadcastFind);
  }
  const sent = new Set();
  const send = (sock, seat) => {
    if (!sock || sent.has(sock.id)) return;
    sent.add(sock.id);
    sock.emit("state", { ...snapshot(room, event), you: seat });
  };
  for (const seat of [0, 1]) {
    const player = room.players[seat];
    if (!player?.socketId) continue;
    send(io.sockets.sockets.get(player.socketId), seat);
  }
  for (const sock of io.sockets.sockets.values()) {
    if (sock.data.roomCode !== room.code || sent.has(sock.id)) continue;
    const seat = seatOf(room, sock.data.playerId);
    if (seat < 0) continue;
    room.players[seat].socketId = sock.id;
    room.players[seat].connected = true;
    send(sock, seat);
  }
}

function claim(socket) {
  const room = rooms.get(socket.data.roomCode);
  const seat = room ? seatOf(room, socket.data.playerId) : -1;
  if (!room || seat < 0) return null;
  const player = room.players[seat];
  player.socketId = socket.id;
  player.connected = true;
  clearForfeit(room, seat);
  socket.join(room.code);
  return { room, seat };
}

function clearForfeit(room, seat) {
  if (!room.forfeitAt) room.forfeitAt = [null, null];
  room.forfeitAt[seat] = null;
  if (room.forfeit[seat]) {
    clearTimeout(room.forfeit[seat]);
    room.forfeit[seat] = null;
  }
}

function presenceToken(current) {
  if (current?.token) return current.token;
  const reserved = new Set([...presence.values()].map((item) => `EGD-${item.token}`));
  return makeRoomCode(reserved).slice(4);
}

function rememberPresence(socket, payload) {
  const name = cleanName(payload.name, "");
  if (!name) {
    presence.delete(socket.id);
    return null;
  }
  const current = presence.get(socket.id);
  const photo = PHOTO_URL.test(payload.photo) ? payload.photo : "";
  const busy = typeof payload.busy === "boolean" ? payload.busy : current?.busy === true;
  const activity = payload.activity === "robot" || payload.activity === "duo" ? payload.activity : "";
  const next = {
    token: presenceToken(current),
    id: playerKey(socket, payload.playerId),
    name,
    photo,
    busy,
    activity: activity || (busy ? current?.activity || "" : ""),
    socketId: socket.id,
  };
  presence.set(socket.id, next);
  noteVisit(socket.data.account || safePlayerId(payload.playerId, ""));
  return next;
}

const visitSeen = new Set();

function noteVisit(playerId) {
  if (!isUuid(playerId) || !dbReady()) return;
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" }).format(new Date());
  const key = `${playerId}:${day}`;
  if (visitSeen.has(key)) return;
  visitSeen.add(key);
  recordVisit(playerId).catch(() => visitSeen.delete(key));
}

function seated(socketId) {
  const socket = io.sockets.sockets.get(socketId);
  if (!socket?.data.roomCode) return false;
  const room = rooms.get(socket.data.roomCode);
  if (!room) return false;
  const seat = seatOf(room, socket.data.playerId);
  return seat >= 0 && room.players[seat]?.socketId === socketId;
}

function roomPhase(socketId) {
  const socket = io.sockets.sockets.get(socketId);
  if (!socket?.data.roomCode) return "";
  const room = rooms.get(socket.data.roomCode);
  if (!room) return "";
  const seat = seatOf(room, socket.data.playerId);
  if (seat < 0 || room.players[seat]?.socketId !== socketId) return "";
  if (room.game?.status === "playing") return "playing";
  if (room.game?.status === "finished") return "finished";
  return "waiting";
}

function seatedRoom(socketId) {
  const socket = io.sockets.sockets.get(socketId);
  const room = socket?.data.roomCode ? rooms.get(socket.data.roomCode) : null;
  if (!room) return null;
  const seat = seatOf(room, socket.data.playerId);
  return seat >= 0 && room.players[seat]?.socketId === socketId ? room : null;
}

function pairState(room) {
  if (!room?.players?.[0] || !room.players[1]) return "";
  const status = room.game?.status;
  if (status === "playing") return "playing";
  if (status === "finished") return room.rematch.some(Boolean) ? "rematch" : "";
  return room.game ? "" : "lobby";
}

function accountBusy(item) {
  if (!item) return false;
  for (const other of presence.values()) {
    const same = other.socketId === item.socketId || (item.id && other.id === item.id);
    if (!same) continue;
    const phase = roomPhase(other.socketId);
    if (phase === "playing" || phase === "waiting") return true;
    if (phase === "finished") continue;
    if (other.busy === true) return true;
  }
  return false;
}

function findPeople(except) {
  const skipId = except?.id || "";
  const byId = new Map();
  for (const item of presence.values()) {
    if (item.socketId === except?.socketId) continue;
    if (skipId && item.id === skipId) continue;
    if (!io.sockets.sockets.has(item.socketId)) continue;
    const key = item.id || item.socketId;
    const current = byId.get(key);
    if (!current || (accountBusy(item) && !accountBusy(current))) byId.set(key, item);
  }
  return [...byId.values()]
    .map((item) => {
      const phase = roomPhase(item.socketId);
      const room = seatedRoom(item.socketId);
      const paired = pairState(room);
      if (paired && !room.matchId) room.matchId = randomBytes(8).toString("hex");
      const activity = paired || phase === "playing" || phase === "waiting"
        ? "duo"
        : phase === "finished"
          ? ""
          : (item.activity === "robot" || item.activity === "duo" ? item.activity : "");
      return {
        token: item.token,
        name: item.name,
        photo: item.photo,
        busy: paired ? true : phase === "finished" ? false : accountBusy(item) || activity !== "",
        activity,
        match: paired ? room.matchId : "",
        matchState: paired,
      };
    })
    .sort((a, b) => Number(a.busy) - Number(b.busy) || a.name.localeCompare(b.name, "fr"))
    .slice(0, 40);
}

function broadcastFind() {
  for (const item of queue.values()) {
    const mine = presence.get(item.socketId) || item;
    io.to(item.socketId).emit("queue", { people: findPeople(mine) });
  }
}

function liveRoom(socket) {
  const room = rooms.get(socket.data.roomCode);
  if (!room) return null;
  const seat = seatOf(room, socket.data.playerId);
  if (seat < 0 || room.players[seat]?.socketId !== socket.id) return null;
  return { room, seat };
}

function socketAlive(socketId) {
  return Boolean(socketId && io.sockets.sockets.has(socketId));
}

function dropRoom(room) {
  for (const index of [0, 1]) clearForfeit(room, index);
  io.to(room.code).emit("closed");
  rooms.delete(room.code);
}

function reapRooms() {
  const now = Date.now();
  for (const [code, room] of rooms) {
    for (const player of room.players) {
      if (player && !socketAlive(player.socketId)) player.connected = false;
    }
    const anyone = room.players.some((player) => player?.connected && socketAlive(player.socketId));
    if (!room.game) {
      const hostGone = !socketAlive(room.players[0]?.socketId);
      if ((hostGone && now - room.touched > 30_000) || now - (room.opened || room.touched) > WAITING_ROOM_MS) {
        dropRoom(room);
      }
      continue;
    }
    if (room.game.status === "playing") {
      const waiting = [0, 1].some((index) => {
        const player = room.players[index];
        return player && !socketAlive(player.socketId) && Number(room.forfeitAt?.[index]) > now;
      });
      if (waiting || anyone) continue;
      if (now - room.touched > PLAY_GRACE_MS) rooms.delete(code);
      continue;
    }
    if (!anyone && now - room.touched > 60_000) rooms.delete(code);
  }
}

function createBlocked(socket) {
  if (limited(`${socket.id}:create`, 4, 60_000)) return true;
  const ip = socket.data.ip;
  if (!ip || ip === "unknown" || isPrivate(ip)) return false;
  return limited(`${ip}:create`, 40, 60_000);
}

function liveSnapshot() {
  reapRooms();
  const people = new Set();
  let robotPlayers = 0;
  for (const item of presence.values()) {
    if (item?.id) people.add(item.id);
    if (item?.activity === "robot") robotPlayers += 1;
  }
  let onlinePlayers = 0;
  let playingRooms = 0;
  let waitingRooms = 0;
  for (const room of rooms.values()) {
    if (room.game?.status === "playing") {
      playingRooms += 1;
      onlinePlayers += room.players.filter((player) => player).length;
    } else if (!room.game) {
      waitingRooms += 1;
    }
  }
  return {
    connected: people.size,
    playing: onlinePlayers + robotPlayers,
    onlinePlayers,
    robotPlayers,
    playingRooms,
    waitingRooms,
    matches: playingRooms + robotPlayers,
    rooms: rooms.size,
  };
}

function leaveRoom(socket) {
  const live = liveRoom(socket);
  if (!live) return;
  const { room, seat } = live;
  socket.leave(room.code);
  socket.data.roomCode = "";
  if (!room.game && seat === 0) {
    dropRoom(room);
    broadcastFind();
    return;
  }
  if (!room.game && seat === 1) {
    room.players[1] = null;
    room.ready[1] = false;
    room.accepted = false;
    emitState(room, { type: "left" });
    broadcastFind();
    return;
  }
  room.players[seat].connected = false;
  room.players[seat].socketId = "";
  room.touched = Date.now();
  if (room.game?.status === "playing") {
    abandon(room.game, seat);
    emitState(room, { type: "abandon" });
  }
  if (!room.players.some((player) => player?.connected && socketAlive(player.socketId))) dropRoom(room);
  broadcastFind();
}

io.on("connection", (socket) => {
  socket.on("create", (payload = {}, ack) => {
    try {
    payload = asObject(payload);
    if (liveRoom(socket)) leaveRoom(socket);
    reapRooms();
    if (rooms.size >= ROOM_LIMIT) return ack?.({ ok: false, error: "Le serveur est plein." });
    if (createBlocked(socket)) return ack?.({ ok: false, error: "Trop de salles créées." });
    const settings = normalizeSettings({ ...payload.settings, p1Name: payload.name });
    const code = makeRoomCode(rooms);
    const room = {
      code,
      settings,
      game: null,
      players: [
        {
          id: playerKey(socket, payload.playerId),
          name: settings.p1Name,
          color: settings.p1Color,
          socketId: socket.id,
          connected: true,
        },
        null,
      ],
      rematch: [false, false],
      ready: [false, false],
      accepted: false,
      forfeit: [null, null],
      forfeitAt: [null, null],
      touched: Date.now(),
      opened: Date.now(),
    };
    rooms.set(code, room);
    queue.delete(socket.id);
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.playerId = room.players[0].id;
    ack?.({ ok: true, code });
    emitState(room, { type: "created" });
    broadcastFind();
    } catch {
      ack?.({ ok: false, error: "La salle n’a pas pu s’ouvrir." });
    }
  });

  socket.on("join", (payload = {}, ack) => {
    try {
    payload = asObject(payload);
    if (limited(`${socket.id}:join`, 12, 60_000)) return ack?.({ ok: false, error: "Trop d'essais. Patiente un peu." });
    const code = roomCode(payload.code);
    const room = code ? rooms.get(code) : null;
    if (!room) return ack?.({ ok: false, error: "Salle introuvable." });
    const key = playerKey(socket, payload.playerId);
    const existing = seatOf(room, key);
    if (existing >= 0) {
      const holder = room.players[existing];
      if (holder.connected && holder.socketId !== socket.id) {
        return ack?.({ ok: false, error: "Ce joueur est déjà dans la salle." });
      }
      const live = liveRoom(socket);
      if (live && live.room.code !== room.code) return ack?.({ ok: false, error: "Quitte d’abord la salle en cours." });
      attach(socket, room, existing, key);
      ack?.({ ok: true, code });
      emitState(room, { type: "rejoin" });
      return;
    }
    if (liveRoom(socket)) return ack?.({ ok: false, error: "Quitte d’abord la salle en cours." });
    if (room.players[1]) return ack?.({ ok: false, error: "Cette salle est complète." });
    const name = cleanName(payload.name, "Joueur 2");
    let color = payload.color;
    if (!PEN_COLORS.includes(color) || color === room.settings.p1Color) {
      color = room.settings.p2Color === room.settings.p1Color ? "red" : room.settings.p2Color;
      if (!PEN_COLORS.includes(color) || color === room.settings.p1Color) {
        color = PEN_COLORS.find((item) => item !== room.settings.p1Color);
      }
    }
    room.settings = { ...room.settings, p2Name: name, p2Color: color };
    room.players[1] = { id: key, name, color, socketId: socket.id, connected: true };
    room.ready[1] = false;
    room.accepted = false;
    queue.delete(socket.id);
    attach(socket, room, 1, room.players[1].id);
    ack?.({ ok: true, code });
    emitState(room, { type: "joined" });
    broadcastFind();
    } catch {
      ack?.({ ok: false, error: "Impossible de rejoindre cette salle." });
    }
  });

  socket.on("rejoin", (payload = {}, ack) => {
    payload = asObject(payload);
    if (limited(`${socket.id}:join`, 12, 60_000)) return ack?.({ ok: false });
    const code = roomCode(payload.code);
    const room = code ? rooms.get(code) : null;
    const key = playerKey(socket, payload.playerId);
    const seat = room ? seatOf(room, key) : -1;
    if (!room || seat < 0) return ack?.({ ok: false });
    const holder = room.players[seat];
    if (holder.socketId && holder.socketId !== socket.id) {
      const previous = io.sockets.sockets.get(holder.socketId);
      if (previous) {
        previous.data.roomCode = "";
        previous.leave(room.code);
      }
    }
    const live = liveRoom(socket);
    if (live && live.room.code !== room.code) return ack?.({ ok: false });
    queue.delete(socket.id);
    attach(socket, room, seat, key);
    ack?.({ ok: true, code: room.code });
    emitState(room, { type: "rejoin" });
    broadcastFind();
  });

  socket.on("react", (emoji) => {
    if (typeof emoji !== "string" || !REACTIONS.includes(emoji)) return;
    if (limited(`${socket.id}:react`, 12, 10_000)) return;
    const found = liveRoom(socket);
    if (!found || found.room.game?.status !== "playing") return;
    for (const seat of [0, 1]) {
      if (seat === found.seat) continue;
      const player = found.room.players[seat];
      const sock = player?.socketId ? io.sockets.sockets.get(player.socketId) : null;
      sock?.emit("react", { code: found.room.code, emoji, seat: found.seat });
    }
  });

function trimChat(room) {
  if (!Array.isArray(room.chat)) return;
  let voices = room.chat.filter((line) => line.audio).length;
  while (voices > 6) {
    const index = room.chat.findIndex((line) => line.audio);
    if (index < 0) break;
    room.chat.splice(index, 1);
    voices -= 1;
  }
  while (room.chat.length > 40) room.chat.shift();
}

socket.on("chat", (text) => {
  if (typeof text !== "string") return;
  const body = text.replace(/[\u0000-\u001f]/g, "").trim().slice(0, 200);
  if (!body || limited(`${socket.id}:chat`, 12, 10_000)) return;
  const found = liveRoom(socket);
  if (!found?.room.game || found.room.game.status === "waiting") return;
  if (!found.room.chat) found.room.chat = [];
  found.room.chat.push({ seat: found.seat, text: body });
  trimChat(found.room);
  const other = found.room.players[1 - found.seat];
  const sock = other?.socketId ? io.sockets.sockets.get(other.socketId) : null;
  sock?.emit("chat", { code: found.room.code, text: body, seat: found.seat });
});

const VOICE_TYPES = /^data:(?:audio|video)\/(webm|ogg|mp4|mpeg|aac|wav|x-wav|x-m4a)((?:;[a-z0-9=.+-]+)*);base64,([A-Za-z0-9+/]+={0,2})$/;

function cleanVoice(value) {
  const audio = String(value || "").replace(/\s/g, "");
  if (audio.length < 80 || audio.length > 2_500_000) return "";
  const match = VOICE_TYPES.exec(audio);
  if (!match) return "";
  return `data:audio/${match[1]}${match[2]};base64,${match[3]}`;
}

socket.on("voice", (payload) => {
  const body = payload && typeof payload === "object" ? payload : { audio: payload };
  const clip = cleanVoice(body.audio);
  const id = String(body.id || "").replace(/[^a-zA-Z0-9-]/g, "").slice(0, 40);
  const seconds = Math.max(0, Math.min(600, Math.round(Number(body.seconds) || 0)));
  if (!clip || !id || limited(`${socket.id}:voice`, 6, 60_000)) return;
  const found = liveRoom(socket);
  if (!found?.room.game || found.room.game.status === "waiting") return;
  if (!found.room.chat) found.room.chat = [];
  if (found.room.chat.some((line) => line.id === id)) return;
  found.room.chat.push({ seat: found.seat, audio: clip, id, seconds });
  trimChat(found.room);
  const message = { code: found.room.code, audio: clip, seat: found.seat, id, seconds };
  for (const seat of [0, 1]) {
    const player = found.room.players[seat];
    const sock = player?.socketId ? io.sockets.sockets.get(player.socketId) : null;
    sock?.emit("voice", message);
  }
});

socket.on("chat-sync", () => {
  const found = liveRoom(socket);
  if (!found) return;
  socket.emit("chat-log", { code: found.room.code, lines: found.room.chat || [] });
});

socket.on("move", (move, ack) => {
    if (limited(`${socket.id}:move`, 300, 60_000)) return ack?.({ ok: false, error: "Trop de coups." });
    const room = rooms.get(socket.data.roomCode);
    const seat = room ? seatOf(room, socket.data.playerId) : -1;
    const play = asMove(move);
    if (!room?.game || room.game.status !== "playing") return ack?.({ ok: false, error: "Partie inactive." });
    if (seat !== room.game.current) return ack?.({ ok: false, error: "Ce n'est pas votre tour." });
    if (!play) return ack?.({ ok: false, error: "Coup impossible." });
    const result = applyMove(room.game, play);
    if (!result.ok) return ack?.({ ok: false, error: "Coup impossible." });
    room.rematch = [false, false];
    ack?.({ ok: true });
    emitState(room, { type: "move", move: play, result });
  });

  socket.on("abandon", () => {
    const room = rooms.get(socket.data.roomCode);
    const seat = room ? seatOf(room, socket.data.playerId) : -1;
    if (!room?.game || seat < 0) return;
    abandon(room.game, seat);
    emitState(room, { type: "abandon" });
  });

  socket.on("rematch", () => {
    const room = rooms.get(socket.data.roomCode);
    const seat = room ? seatOf(room, socket.data.playerId) : -1;
    if (!room?.game || seat < 0 || room.game.status !== "finished") return;
    room.rematch[seat] = true;
    if (room.rematch[0] && room.rematch[1]) {
      const starter = room.game.starter === 0 ? 1 : 0;
      room.game = createGame(room.settings, starter);
      room.startedAt = Date.now();
      room.saved = false;
      room.saving = false;
      room.rematch = [false, false];
      emitState(room, { type: "rematch" });
    } else {
      emitState(room, { type: "rematch-wait" });
    }
  });

  socket.on("rematch-no", () => {
    const room = rooms.get(socket.data.roomCode);
    const seat = room ? seatOf(room, socket.data.playerId) : -1;
    if (!room?.game || seat < 0 || room.game.status !== "finished") return;
    if (!room.rematch.some(Boolean)) return;
    room.rematch = [false, false];
    emitState(room, { type: "rematch-no" });
  });

  socket.on("present", () => {
    const found = claim(socket);
    if (!found || found.room.game || limited(`${socket.id}:present`, 40, 60_000)) return;
    found.room.ready[found.seat] = true;
    emitState(found.room, { type: "present" });
  });

  socket.on("accept", () => {
    const found = claim(socket);
    const room = found?.room;
    const seat = found ? found.seat : -1;
    if (!room || seat !== 1 || room.game || !room.players[1] || limited(`${socket.id}:accept`, 20, 60_000)) return;
    room.accepted = true;
    emitState(room, { type: "accept" });
  });

  socket.on("table", (patch = {}) => {
    patch = asObject(patch);
    const room = rooms.get(socket.data.roomCode);
    const seat = room ? seatOf(room, socket.data.playerId) : -1;
    if (!room || seat !== 0 || room.game || limited(`${socket.id}:table`, 20, 60_000)) return;
    const next = { ...room.settings };
    if (patch.timeMode === "none" || patch.timeMode === "global") next.timeMode = patch.timeMode;
    if (Number.isFinite(Number(patch.timeLimit))) next.timeLimit = Number(patch.timeLimit);
    if (Number.isFinite(Number(patch.scoreLimit))) next.scoreLimit = Number(patch.scoreLimit);
    room.settings = normalizeSettings(next);
    room.accepted = false;
    emitState(room, { type: "settings" });
  });

  socket.on("launch", () => {
    const found = claim(socket);
    const room = found?.room;
    const seat = found ? found.seat : -1;
    if (!room || seat !== 0 || room.game || limited(`${socket.id}:launch`, 8, 60_000)) return;
    if (!room.players[1]?.connected || !room.ready[0] || !room.ready[1]) return;
    room.game = createGame(room.settings, 0);
    room.startedAt = Date.now();
    room.saved = false;
    room.saving = false;
    emitState(room, { type: "start" });
  });

  socket.on("presence", (payload = {}) => {
    payload = asObject(payload);
    if (limited(`${socket.id}:presence`, 30, 60_000)) return;
    rememberPresence(socket, payload);
    broadcastFind();
  });

  socket.on("queue-join", (payload = {}) => {
    payload = asObject(payload);
    if (limited(`${socket.id}:queue`, 20, 60_000)) return;
    const mine = rememberPresence(socket, payload);
    const live = liveRoom(socket);
    if (live?.room.game) {
      socket.emit("queue", { people: findPeople(mine) });
      return;
    }
    if (live) leaveRoom(socket);
    if (!mine) return;
    if (queue.size >= QUEUE_LIMIT && !queue.has(socket.id)) return;
    queue.set(socket.id, mine);
    broadcastFind();
  });

  socket.on("queue-leave", () => {
    if (!queue.delete(socket.id)) return;
    broadcastFind();
  });

  socket.on("invite", (payload = {}) => {
    payload = asObject(payload);
    if (limited(`${socket.id}:invite`, 8, 60_000)) return;
    const token = queueToken(payload.token);
    const host = presence.get(socket.id);
    const guest = token ? [...presence.values()].find((item) => item.token === token && item.socketId !== socket.id) : null;
    if (!host || !guest || accountBusy(guest)) return;
    io.to(guest.socketId).emit("invite", { from: host.name, token: host.token });
  });

  socket.on("invite-answer", (payload = {}) => {
    payload = asObject(payload);
    if (!payload.yes || limited(`${socket.id}:invite-answer`, 6, 60_000)) return;
    const token = queueToken(payload.token);
    const guest = presence.get(socket.id);
    const host = token ? [...presence.values()].find((item) => item.token === token) : null;
    const hostSocket = host ? io.sockets.sockets.get(host.socketId) : null;
    if (!guest || !host || !hostSocket || host.socketId === socket.id) return;
    if (accountBusy(guest) || accountBusy(host)) {
      socket.emit("notice", "Cette personne est occupée.");
      return;
    }
    if (liveRoom(socket)?.room.game || liveRoom(hostSocket)?.room.game) {
      socket.emit("notice", "Tu es déjà dans une partie.");
      return;
    }
    reapRooms();
    if (rooms.size >= ROOM_LIMIT) {
      socket.emit("notice", "La table n’a pas pu s’ouvrir.");
      return;
    }
    if (liveRoom(socket)) leaveRoom(socket);
    if (liveRoom(hostSocket)) leaveRoom(hostSocket);
    const settings = normalizeSettings({
      rows: 32,
      cols: 24,
      extraTurn: true,
      timeMode: "none",
      scoreLimit: 10,
      theme: "classic",
      closeMode: "auto",
      p1Color: "blue",
      p2Color: "black",
      p1Name: host.name,
      p2Name: guest.name,
    });
    const code = makeRoomCode(rooms);
    const room = {
      code,
      settings,
      game: null,
      players: [
        { id: host.id, name: host.name, color: settings.p1Color, socketId: host.socketId, connected: true },
        { id: guest.id, name: guest.name, color: settings.p2Color, socketId: guest.socketId, connected: true },
      ],
      rematch: [false, false],
      ready: [false, false],
      accepted: false,
      forfeit: [null, null],
      forfeitAt: [null, null],
      touched: Date.now(),
      opened: Date.now(),
      direct: true,
    };
    rooms.set(code, room);
    queue.delete(host.socketId);
    queue.delete(guest.socketId);
    attach(hostSocket, room, 0, host.id);
    attach(socket, room, 1, guest.id);
    broadcastFind();
    emitState(room, { type: "joined" });
  });

  socket.on("leave", () => leaveRoom(socket));

  socket.on("disconnect", () => {
    presence.delete(socket.id);
    queue.delete(socket.id);
    broadcastFind();
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    const seat = seatOf(room, socket.data.playerId);
    if (seat < 0 || room.players[seat].socketId !== socket.id) return;
    room.touched = Date.now();
    clearForfeit(room, seat);
    if (room.game?.status === "playing") {
      room.players[seat].connected = false;
      if (!room.forfeitAt) room.forfeitAt = [null, null];
      room.forfeitAt[seat] = Date.now() + PLAY_GRACE_MS;
      emitState(room, { type: "presence" });
      room.forfeit[seat] = setTimeout(() => {
        const player = room.players[seat];
        if (!player || player.connected || player.socketId !== socket.id) return;
        if (room.game?.status === "playing") {
          abandon(room.game, seat);
          emitState(room, { type: "forfeit" });
        }
      }, PLAY_GRACE_MS);
      return;
    }
    room.forfeit[seat] = setTimeout(() => {
      const player = room.players[seat];
      if (!player || player.socketId !== socket.id) return;
      player.connected = false;
      room.ready[seat] = false;
      if (seat === 1) {
        room.players[1] = null;
        room.accepted = false;
      }
      emitState(room, { type: "left" });
    }, 20000);
  });
});

function attach(socket, room, seat, id) {
  clearForfeit(room, seat);
  room.players[seat].socketId = socket.id;
  room.players[seat].connected = true;
  room.players[seat].id = id;
  socket.join(room.code);
  socket.data.roomCode = room.code;
  socket.data.playerId = id;
}

setInterval(() => {
  reapRooms();
  const now = Date.now();
  for (const [code, room] of rooms) {
    const playing = room.game?.status === "playing" && room.players[0]?.connected && room.players[1]?.connected;
    if (playing) {
      const dt = room.clockAt ? Math.max(0, now - room.clockAt) : 200;
      room.clockAt = now;
      const clock = tick(room.game, dt);
      if (clock.timedOut && clock.kind === "turn") {
        const moves = legalMoves(room.game);
        if (moves.length) {
          const move = moves[Math.floor(Math.random() * moves.length)];
          const result = applyMove(room.game, move);
          emitState(room, { type: "timeout", move, result });
        }
      } else if (clock.timedOut && clock.kind === "global") {
        emitState(room, { type: "time" });
      }
    } else {
      room.clockAt = now;
    }
  }
  for (const [key, times] of hits) {
    const fresh = times.filter((time) => now - time < 60 * 60 * 1000);
    if (!fresh.length) hits.delete(key);
    else if (fresh.length !== times.length) hits.set(key, fresh);
  }
}, 200);

const port = Number(process.env.PORT) || 4173;
const host = process.env.HOST || "127.0.0.1";

initDb()
  .catch((error) => {
    console.error("Base indisponible:", error.message);
  })
  .finally(() => {
    httpServer.listen(port, host, () => {
      const base = dbReady() ? "avec la base" : "sans base, profil dans le navigateur";
      console.log(`Jeu - chimie prêt sur http://${host}:${port} ${base}`);
    });
  });
