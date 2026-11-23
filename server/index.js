import express from "express";
import { createServer } from "http";
import { createHash, randomBytes, randomInt, randomUUID, scrypt, timingSafeEqual } from "crypto";
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
  skipTurn,
  REACTIONS,
} from "../public/js/engine.js";
import {
  LEARN_NAMES,
  boardSnap,
  learnFingerprint,
  LEARN_CHECKPOINT,
} from "./learn.js";
import { runLearnJob } from "./learnJobs.js";
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
  activeTourneyOf,
  recentTourneyOf,
  tourneyHistoryOf,
  cancelStaleTourneys,
  createTourney,
  joinTourney,
  leaveTourney,
  launchTourney,
  tourneyPlayerIds,
  tourneyState,
  tourneyMatchesToStart,
  tourneyPeople,
  deleteOfficial,
  deleteFriendTourney,
  officialDueCodes,
  officialTourneys,
  robotOverview,
  OFFICIAL_OPEN_MINUTES,
  TOURNEY_SHOW_UP_MS,
  markMatchPlaying,
  finishMatch,
  resetPlayingMatches,
  initDb,
  insertGame,
  insertLearnMatch,
  findLearnWatchIds,
  learnOverview,
  getLearnMatch,
  replaceLearnSituations,
  listLearnMatchesNeedingAnalysis,
  insertLearnRun,
  updateLearnMeta,
  getLearnMeta,
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
  if (!name) {
    res.status(400).json({ error: "Écris ton nom.", field: "name" });
    return;
  }
  if (!EMAIL_OK.test(email)) {
    res.status(400).json({ error: "Cet e-mail n’est pas valide.", field: "email" });
    return;
  }
  if (!id) {
    res.status(400).json({ error: "Recharge la page, puis réessaie." });
    return;
  }
  const saved = await saveAccount({ id, name, email, passwordHash: await hashPassword(password) });
  if (saved.error) {
    res.status(409).json({ error: saved.error, field: saved.error.includes("e-mail") ? "claim" : "" });
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
  if (!key) {
    res.status(400).json({ error: "Écris ton nom ou ton e-mail.", field: "key" });
    return;
  }
  if (password.length < 1 || password.length > 80) {
    res.status(400).json({ error: "Écris ton mot de passe." });
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
  if (!account?.id) return;
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
  if (!account?.id || !(await useResetCode(account.id, code))) {
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
  res.json({
    ...overview,
    live: liveSnapshot(),
    tourneys: await officialTourneys(null, { all: true }),
    robot: await robotOverview(),
    learn: await learnOverview(),
  });
}));

app.post("/api/admin/learn/analyze", api(async (req, res) => {
  if (!dbReady()) {
    res.status(503).json({ error: "Base indisponible." });
    return;
  }
  const adminId = await sessionPlayer(readCookie(req, "egmon_session"));
  if (!adminId) {
    res.status(401).json({ error: "Connexion requise." });
    return;
  }
  const profile = await readProfile(adminId);
  if (!isAdminAccount(profile)) {
    res.status(403).json({ error: "Accès refusé." });
    return;
  }
  if (limited(`${adminId}:learn-analyze`, 10, 60_000)) {
    res.status(429).json({ error: "Trop d'essais." });
    return;
  }
  const started = startLearnAnalysis(80, { recordRun: true });
  res.json({ ok: true, started, learn: await learnOverview() });
}));

app.post("/api/admin/learn/model", api(async (req, res) => {
  if (!dbReady()) {
    res.status(503).json({ error: "Base indisponible." });
    return;
  }
  const adminId = await sessionPlayer(readCookie(req, "egmon_session"));
  if (!adminId) {
    res.status(401).json({ error: "Connexion requise." });
    return;
  }
  const profile = await readProfile(adminId);
  if (!isAdminAccount(profile)) {
    res.status(403).json({ error: "Accès refusé." });
    return;
  }
  const action = String(req.body?.action || "");
  const meta = await getLearnMeta();
  if (action === "activate") {
    if (!meta.candidateVersion) {
      res.status(400).json({ error: "Pas de candidat. Termine d’abord la phase 3." });
      return;
    }
    const veryhard = req.body?.veryhard === true;
    const expert = req.body?.expert === true;
    if (!veryhard && !expert) {
      res.status(400).json({ error: "Choisis Très difficile et/ou Expert." });
      return;
    }
    const next = await updateLearnMeta({
      veryhardUsesCandidate: veryhard,
      expertUsesCandidate: expert,
      status: "termine",
      lastError: "",
    });
    const overview = await learnOverview();
    await insertLearnRun({
      kind: "activation",
      status: "ok",
      modelVersion: next.candidateVersion || next.activeVersion,
      matches: overview.matches,
      moves: overview.moves,
      situations: overview.situations?.total || 0,
      report: overview.report,
      detail: { veryhard, expert },
    });
    res.json({ ok: true, learn: await learnOverview() });
    return;
  }
  if (action === "revert") {
    const next = await updateLearnMeta({
      veryhardUsesCandidate: false,
      expertUsesCandidate: false,
      clearCandidate: false,
      status: meta.candidateVersion ? "validation" : "analyse",
      lastError: "",
    });
    const overview = await learnOverview();
    await insertLearnRun({
      kind: "retour",
      status: "ok",
      modelVersion: next.activeVersion || "v1",
      matches: overview.matches,
      moves: overview.moves,
      situations: overview.situations?.total || 0,
      report: "Retour au robot actuel (v1) sur Très difficile et Expert.",
      detail: { activeVersion: next.activeVersion },
    });
    res.json({ ok: true, learn: await learnOverview() });
    return;
  }
  res.status(400).json({ error: "Action inconnue." });
}));

app.get("/api/admin/learn/:id", api(async (req, res) => {
  if (!dbReady()) {
    res.status(503).json({ error: "Base indisponible." });
    return;
  }
  const adminId = await sessionPlayer(readCookie(req, "egmon_session"));
  if (!adminId) {
    res.status(401).json({ error: "Connexion requise." });
    return;
  }
  const profile = await readProfile(adminId);
  if (!isAdminAccount(profile)) {
    res.status(403).json({ error: "Accès refusé." });
    return;
  }
  const match = await getLearnMatch(req.params.id);
  if (!match) {
    res.status(404).json({ error: "Partie introuvable." });
    return;
  }
  let replay = null;
  try {
    replay = await runLearnJob("replay", match);
  } catch (error) {
    replay = { ok: false, error: error.message };
  }
  res.json({ match, replay });
}));

const LEARN_LEVELS = new Set(["easy", "medium", "hard", "veryhard", "expert"]);

/** Fin d'une partie contre le robot : toujours la même réponse vide, aucun signal au joueur. */
app.post("/api/learn/solo", api(async (req, res) => {
  res.status(204).end();
  if (!dbReady()) return;
  const id = await sessionPlayer(readCookie(req, "egmon_session"));
  if (!id || limited(`${id}:learn-solo`, 40, 60 * 60 * 1000)) return;
  if (!(await learnWatchIds()).has(id)) return;
  const body = asObject(req.body);
  const rows = Number(body.rows);
  const cols = Number(body.cols);
  const level = String(body.difficulty || "");
  // Chaque coup tient en 3 caractères : joueur (0/1), ligne et colonne en base 36.
  const packed = typeof body.moves === "string" && /^([01][0-9a-z]{2})+$/.test(body.moves) ? body.moves : "";
  const moves = [];
  for (let i = 0; i < packed.length; i += 3) {
    moves.push({ seat: Number(packed[i]), r: parseInt(packed[i + 1], 36), c: parseInt(packed[i + 2], 36) });
  }
  const scores = Array.isArray(body.scores) ? body.scores.map(Number) : [];
  if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows < 2 || cols < 2 || rows > 32 || cols > 32) return;
  if (!LEARN_LEVELS.has(level) || moves.length < 4 || moves.length > (rows + 1) * (cols + 1) || scores.length !== 2) return;
  const steps = [];
  for (const [step, move] of moves.entries()) {
    const r = Number(move?.r);
    const c = Number(move?.c);
    const seat = Number(move?.seat);
    if (!Number.isInteger(r) || !Number.isInteger(c) || r < 0 || c < 0 || r > rows || c > cols || (seat !== 0 && seat !== 1)) return;
    steps.push({ step, seat, r, c, after: null, at: Date.now() });
  }
  const settings = normalizeSettings({
    rows,
    cols,
    extraTurn: body.extraTurn !== false,
    scoreLimit: Number(body.scoreLimit) || 0,
    difficulty: level,
  });
  const starter = Number(body.starter) === 1 ? 1 : 0;
  const winner = body.winner === 0 || body.winner === 1 ? String(body.winner) : "draw";
  const endedAt = Date.now();
  const durationMs = Math.min(Math.max(0, Math.round(Number(body.durationMs) || 0)), 6 * 60 * 60 * 1000);
  const replay = await runLearnJob("replay", { settings, starter, moves: steps, winner }).catch(() => null);
  if (!replay?.ok || replay.scores[0] !== scores[0] || replay.scores[1] !== scores[1]) return;
  const early = ["abandon", "robot", "time"].includes(String(body.reason || ""));
  if (replay.status !== "finished" && !early) return;
  const name = (await readProfile(id))?.name || "Joueur";
  const label = { easy: "Facile", medium: "Moyen", hard: "Difficile", veryhard: "Très difficile", expert: "Expert" }[level];
  const result = await insertLearnMatch({
    id: randomUUID(),
    fingerprint: `${id}|robot:${level}|${rows}x${cols}|${createHash("sha256").update(packed).digest("hex").slice(0, 32)}`,
    roomCode: "",
    player0Id: id,
    player1Id: null,
    player0Name: cleanName(name, "Joueur"),
    player1Name: `Robot · ${label}`,
    startedAt: endedAt - durationMs,
    endedAt,
    durationMs: Math.max(1, durationMs),
    rows,
    cols,
    starter,
    scores,
    winner,
    reason: body.reason ? String(body.reason).slice(0, 24) : null,
    settings,
    moveCount: steps.length,
    moves: steps,
    opponent: "robot",
    difficulty: level,
  }).catch((error) => {
    console.error("Learn robot:", error.message);
    return null;
  });
  if (result?.ok && !result.duplicate) startLearnAnalysis(5);
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

const TOURNEY_CODE = /^TRN-[A-HJ-NP-Z2-9]{6}$/;
const TOURNEY_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const TOURNEY_ERRORS = {
  unknown: [404, "Aucun tournoi avec ce code."],
  started: [409, "Ce tournoi a déjà commencé."],
  full: [409, "Ce tournoi est complet."],
  active: [409, "Tu es déjà dans un autre tournoi."],
  creator: [403, "Seul le créateur peut lancer le tournoi."],
  missing: [409, "Il faut que toutes les places soient prises."],
  organizer: [409, "Tu organises ce tournoi : tu ne peux pas y jouer."],
  notCreator: [403, "Seul le créateur peut supprimer ce tournoi."],
  early: [409, `La validation de présence ouvre ${OFFICIAL_OPEN_MINUTES} minutes avant le début.`],
  running: [409, "Ce tournoi est en cours : attends la fin pour le supprimer."],
};

function tourneyCode(value) {
  const code = String(value || "").trim().toUpperCase();
  return TOURNEY_CODE.test(code) ? code : "";
}

function newTourneyCode() {
  let code = "TRN-";
  for (let i = 0; i < 6; i += 1) code += TOURNEY_CHARS[randomInt(0, TOURNEY_CHARS.length)];
  return code;
}

function tourneyError(res, result) {
  const [status, message] = TOURNEY_ERRORS[result.error] || [400, "Action impossible."];
  res.status(status).json({ error: message, code: result.code || "" });
}

async function broadcastTourney(code) {
  for (const playerId of await tourneyPlayerIds(code)) {
    const sockets = [...io.sockets.sockets.values()].filter((sock) => sock.data.account === playerId);
    if (!sockets.length) continue;
    const state = await tourneyState(code, playerId);
    for (const sock of sockets) sock.emit("tourney", state);
  }
}

let tourneysChangedTimer = null;

function tourneysChanged() {
  if (tourneysChangedTimer) return;
  tourneysChangedTimer = setTimeout(() => {
    tourneysChangedTimer = null;
    io.emit("tourneys-changed");
  }, 400);
}

function broadcastTourneyLater(code) {
  broadcastTourney(code).catch((error) => console.error("Tournoi:", error.message));
  tourneysChanged();
}

app.get("/api/tourneys/mine", api(async (req, res) => {
  const id = await sessionAccount(req, res);
  if (!id) return;
  const code = await activeTourneyOf(id);
  const recent = code ? "" : await recentTourneyOf(id);
  res.json({
    code,
    state: code ? await tourneyState(code, id) : null,
    recent: recent ? await tourneyState(recent, id) : null,
  });
}));

app.get("/api/tourneys/history", api(async (req, res) => {
  const id = await sessionAccount(req, res);
  if (id) res.json({ items: await tourneyHistoryOf(id) });
}));

app.get("/api/tourneys/official", api(async (req, res) => {
  if (!dbReady()) {
    res.status(503).json({ error: "Base indisponible." });
    return;
  }
  if (ipLimited(clientIp(req), "tourney-official", 60, 60_000)) {
    res.status(429).json({ error: "Trop d'essais." });
    return;
  }
  const viewer = await sessionPlayer(readCookie(req, "egmon_session"));
  res.json({ items: await officialTourneys(viewer) });
}));

async function adminAccount(req, res) {
  if (!dbReady()) {
    res.status(503).json({ error: "Base indisponible." });
    return null;
  }
  const id = await sessionPlayer(readCookie(req, "egmon_session"));
  if (!id) {
    res.status(401).json({ error: "Connexion requise." });
    return null;
  }
  if (limited(`${id}:admin`, 40, 60_000)) {
    res.status(429).json({ error: "Trop d'essais." });
    return null;
  }
  if (!isAdminAccount(await readProfile(id))) {
    res.status(403).json({ error: "Accès refusé." });
    return null;
  }
  return id;
}

app.post("/api/admin/tourneys", api(async (req, res) => {
  const id = await adminAccount(req, res);
  if (!id) return;
  const name = String(req.body?.name || "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, 40);
  if (!name) {
    res.status(400).json({ error: "Donne un nom au tournoi." });
    return;
  }
  const size = Number(req.body?.size) || 4;
  if (size !== 4 && size !== 8) {
    res.status(400).json({ error: "Choisis 4 ou 8 joueurs." });
    return;
  }
  let startsAt = null;
  if (req.body?.startsAt) {
    const when = new Date(Number(req.body.startsAt));
    const now = Date.now();
    if (!Number.isFinite(when.getTime()) || when.getTime() < now + 60_000 || when.getTime() > now + 60 * 24 * 60 * 60_000) {
      res.status(400).json({ error: "Choisis une heure dans le futur (60 jours au plus)." });
      return;
    }
    startsAt = when;
  }
  let result = { error: "code" };
  for (let tries = 0; tries < 5 && result.error === "code"; tries += 1) {
    result = await createTourney({ creatorId: id, name, code: newTourneyCode(), official: true, size, startsAt });
  }
  if (result.error) {
    tourneyError(res, result);
    return;
  }
  tourneysChanged();
  res.json({ code: result.code, tourneys: await officialTourneys(null, { all: true }) });
}));

app.post("/api/admin/tourneys/delete", api(async (req, res) => {
  const id = await adminAccount(req, res);
  if (!id) return;
  const code = tourneyCode(req.body?.code);
  const result = code ? await deleteOfficial(code) : { error: "unknown" };
  if (result.error) {
    tourneyError(res, result);
    return;
  }
  if (result.cancelled) {
    broadcastTourneyLater(code);
    tourneyCancelAlertLater(code, id);
  } else {
    tourneysChanged();
  }
  res.json({ ok: true, tourneys: await officialTourneys(null, { all: true }) });
}));

app.post("/api/admin/tourneys/start", api(async (req, res) => {
  const id = await adminAccount(req, res);
  if (!id) return;
  const code = tourneyCode(req.body?.code);
  const result = code ? await launchTourney(code, id) : { error: "unknown" };
  if (result.error) {
    tourneyError(res, result);
    return;
  }
  await startTourneyMatches(code);
  res.json({ ok: true, tourneys: await officialTourneys(null, { all: true }) });
}));

app.get("/api/tourneys/:code", api(async (req, res) => {
  const id = await sessionAccount(req, res);
  if (!id) return;
  const code = tourneyCode(req.params.code);
  const state = code ? await tourneyState(code, id) : null;
  if (!state || (!state.youIn && !state.official)) {
    res.status(404).json({ error: "Aucun tournoi avec ce code." });
    return;
  }
  res.json(state);
}));

app.post("/api/tourneys", api(async (req, res) => {
  const id = await sessionAccount(req, res);
  if (!id) return;
  if (limited(`${id}:tourney-create`, 5, 60 * 60 * 1000)) {
    res.status(429).json({ error: "Trop de tournois créés. Réessaie plus tard." });
    return;
  }
  const name = String(req.body?.name || "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, 40);
  if (!name) {
    res.status(400).json({ error: "Donne un nom au tournoi." });
    return;
  }
  const size = Number(req.body?.size) === 8 ? 8 : 4;
  let result = { error: "code" };
  for (let tries = 0; tries < 5 && result.error === "code"; tries += 1) {
    result = await createTourney({ creatorId: id, name, code: newTourneyCode(), size });
  }
  if (result.error) {
    tourneyError(res, result);
    return;
  }
  res.json(await tourneyState(result.code, id));
}));

app.post("/api/tourneys/join", api(async (req, res) => {
  const id = await sessionAccount(req, res);
  if (!id) return;
  if (limited(`${id}:tourney-join`, 20, 10 * 60_000)) {
    res.status(429).json({ error: "Trop d'essais. Patiente un peu." });
    return;
  }
  const code = tourneyCode(req.body?.code);
  if (!code) {
    res.status(400).json({ error: "Le code a la forme TRN- suivie de 6 lettres ou chiffres." });
    return;
  }
  const result = await joinTourney(code, id);
  if (result.error) {
    tourneyError(res, result);
    return;
  }
  if (!result.already) {
    broadcastTourneyLater(code);
    tourneyFullAlertLater(code);
  }
  res.json(await tourneyState(code, id));
}));

app.post("/api/tourneys/leave", api(async (req, res) => {
  const id = await sessionAccount(req, res);
  if (!id) return;
  const code = tourneyCode(req.body?.code);
  const result = code ? await leaveTourney(code, id) : { error: "unknown" };
  if (result.error) {
    tourneyError(res, result);
    return;
  }
  broadcastTourneyLater(code);
  if (result.cancelled) tourneyCancelAlertLater(code, id);
  res.json({ ok: true, cancelled: result.cancelled === true });
}));

app.post("/api/tourneys/delete", api(async (req, res) => {
  const id = await sessionAccount(req, res);
  if (!id) return;
  const code = tourneyCode(req.body?.code);
  const result = code ? await deleteFriendTourney(code, id) : { error: "unknown" };
  if (result.error) {
    tourneyError(res, result);
    return;
  }
  // Les inscrits encore sur la page du tournoi sont renvoyés, puis prévenus dans la cloche.
  const gone = { code, name: result.name, status: "cancelled", official: false, youIn: true, youCreator: false, deleted: true };
  for (const sock of io.sockets.sockets.values()) {
    if (result.players.includes(sock.data.account) && sock.data.account !== id) sock.emit("tourney", gone);
  }
  for (const playerId of result.players) {
    if (playerId === id) continue;
    notifyLater(playerId, {
      kind: "tournament",
      ref: `${code}:deleted`,
      title: `« ${result.name} » est supprimé`,
      body: "Le créateur a supprimé ce tournoi avant le début.",
      link: "",
    });
  }
  tourneysChanged();
  res.json({ ok: true });
}));

app.post("/api/tourneys/launch", api(async (req, res) => {
  const id = await sessionAccount(req, res);
  if (!id) return;
  const code = tourneyCode(req.body?.code);
  const result = code ? await launchTourney(code, id) : { error: "unknown" };
  if (result.error) {
    tourneyError(res, result);
    return;
  }
  await startTourneyMatches(code);
  res.json(await tourneyState(code, id));
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

setInterval(() => {
  if (!dbReady()) return;
  cancelStaleTourneys()
    .then((codes) => codes.forEach((code) => {
      broadcastTourneyLater(code);
      tourneyCancelAlertLater(code, "");
    }))
    .catch((error) => console.error("Tournois en attente:", error.message));
}, 30 * 60 * 1000).unref();

let startingDue = false;

async function startDueOfficials() {
  if (startingDue || !dbReady()) return;
  startingDue = true;
  try {
    for (const code of await officialDueCodes()) {
      const result = await launchTourney(code, null);
      if (result.ok) await startTourneyMatches(code);
    }
  } finally {
    startingDue = false;
  }
}

setInterval(() => {
  startDueOfficials().catch((error) => console.error("Tournois à l'heure:", error.message));
}, 15_000).unref();

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
    tournament: room.tournament
      ? { code: room.tournament.code, round: room.tournament.round, showUpBy: room.tournament.showUpBy }
      : null,
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

const TOURNEY_RULES = {
  quarter: { timeMode: "global", timeLimit: 600, turnSeconds: 20, suddenDeath: true, scoreLimit: 0 },
  semi: { timeMode: "global", timeLimit: 600, turnSeconds: 20, suddenDeath: true, scoreLimit: 0 },
  final: { timeMode: "none", scoreLimit: 10, turnSeconds: 20 },
};

function durationText(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (!minutes) return `${seconds} s`;
  return seconds ? `${minutes} min ${String(seconds).padStart(2, "0")}` : `${minutes} min`;
}

const SHOW_UP_TEXT = durationText(TOURNEY_SHOW_UP_MS);

async function tourneyAlert(playerId, note, push = false) {
  const link = `tournoi:${note.code}`;
  const saved = await notify(playerId, { kind: "tournament", ref: note.ref, title: note.title, body: note.body, link });
  if (!saved || !push || accountOnline(playerId)) return;
  await pushTo(playerId, {
    title: note.title,
    body: note.body,
    url: `/?tournoi=${encodeURIComponent(note.code)}`,
    tag: `tournoi-${note.code}`,
  });
}

function tourneyAlertsLater(job) {
  if (!dbReady()) return;
  job().catch((error) => console.error("Notification de tournoi:", error.message));
}

function tourneyFullAlertLater(code) {
  tourneyAlertsLater(async () => {
    const people = await tourneyPeople(code);
    if (!people || people.status !== "waiting" || people.players.length < people.size) return;
    if (people.official) {
      for (const player of people.players) {
        await tourneyAlert(player.id, {
          code,
          ref: `${code}:full`,
          title: `Ta place est gardée dans « ${people.name} »`,
          body: `Les ${people.size} places sont prises. Reste près de ton écran : le tournoi va démarrer.`,
        }, true);
      }
      await tourneyAlert(people.creatorId, {
        code,
        ref: `${code}:full`,
        title: `« ${people.name} » est complet`,
        body: `Les ${people.size} joueurs ont validé leur présence. Tu peux démarrer le tournoi dans Admin → Compétitions.`,
      }, true);
      return;
    }
    await tourneyAlert(people.creatorId, {
      code,
      ref: `${code}:full`,
      title: `« ${people.name} » est complet`,
      body: `Les ${people.size} joueurs sont là. Tu peux lancer le tournoi.`,
    }, true);
  });
}

function tourneyCancelAlertLater(code, byId) {
  tourneyAlertsLater(async () => {
    const people = await tourneyPeople(code);
    if (!people) return;
    for (const player of people.players) {
      if (player.id === byId) continue;
      await tourneyAlert(player.id, {
        code,
        ref: `${code}:cancel`,
        title: `« ${people.name} » est annulé`,
        body: people.official
          ? "Jeu - chimie a annulé ce tournoi officiel."
          : byId ? "Le créateur a annulé le tournoi." : "Le tournoi n’a pas été lancé à temps.",
      });
    }
  });
}

function tourneyMatchAlertLater(code, match) {
  tourneyAlertsLater(async () => {
    const people = await tourneyPeople(code);
    if (!people) return;
    const title = {
      final: `La finale de « ${people.name} » est prête`,
      semi: `Ta demi-finale de « ${people.name} » commence`,
      quarter: `Ton quart de finale de « ${people.name} » commence`,
    }[match.round];
    for (const [me, other] of [[match.p1, match.p2_name], [match.p2, match.p1_name]]) {
      await tourneyAlert(me, {
        code,
        ref: `${code}:${match.round}:start`,
        title,
        body: `Contre ${other}. Viens dans les ${SHOW_UP_TEXT}, sinon c’est perdu par forfait.`,
      }, true);
    }
  });
}

function tourneyResultAlertLater(result) {
  tourneyAlertsLater(async () => {
    const people = await tourneyPeople(result.code);
    if (!people) return;
    const nameOf = (id) => people.players.find((player) => player.id === id)?.name || "Un joueur";
    const code = result.code;
    if (result.round !== "final") {
      const played = result.round === "quarter" ? "le quart de finale" : "la demi-finale";
      await tourneyAlert(result.loser, {
        code,
        ref: `${code}:${result.round}:out`,
        title: `Éliminé de « ${people.name} »`,
        body: `${nameOf(result.winner)} a gagné ${played}. Tu peux suivre la suite dans l’arbre.`,
      });
      if (result.next === "wait") {
        const reached = result.nextRound === "final" ? "en finale" : "en demi-finale";
        const other = result.round === "quarter" ? "l’autre quart de finale de ton côté" : "l’autre demi-finale";
        await tourneyAlert(result.winner, {
          code,
          ref: `${code}:${result.round}:win`,
          title: `Tu es ${reached} de « ${people.name} »`,
          body: `Ton prochain match commencera dès que ${other} sera fini.`,
        });
      }
      return;
    }
    for (const player of people.players) {
      const won = player.id === result.winner;
      const second = player.id === result.runnerUp;
      await tourneyAlert(player.id, {
        code,
        ref: `${code}:done`,
        title: won ? `Tu as gagné « ${people.name} » !` : second ? `Finaliste de « ${people.name} »` : `« ${people.name} » est terminé`,
        body: won
          ? "Bravo ! +150 XP au classement."
          : second
            ? `${nameOf(result.winner)} a gagné la finale. +100 XP au classement.`
            : `${nameOf(result.winner)} a gagné le tournoi.`,
      }, won || second);
    }
  });
}

async function startTourneyMatches(code) {
  for (const match of await tourneyMatchesToStart(code)) {
    const roomCode = makeRoomCode(rooms);
    if (!(await markMatchPlaying(match.id, roomCode))) continue;
    const settings = normalizeSettings({
      ...TOURNEY_RULES[match.round],
      p1Name: match.p1_name,
      p2Name: match.p2_name,
      p1Color: "blue",
      p2Color: "red",
    });
    rooms.set(roomCode, {
      code: roomCode,
      settings,
      game: null,
      players: [
        { id: match.p1, name: settings.p1Name, color: settings.p1Color, socketId: "", connected: false },
        { id: match.p2, name: settings.p2Name, color: settings.p2Color, socketId: "", connected: false },
      ],
      rematch: [false, false],
      ready: [false, false],
      accepted: false,
      forfeit: [null, null],
      forfeitAt: [null, null],
      touched: Date.now(),
      opened: Date.now(),
      tournament: {
        code,
        matchId: match.id,
        round: match.round,
        showUpBy: Date.now() + TOURNEY_SHOW_UP_MS,
        arrived: [false, false],
        waitingSent: false,
        done: false,
      },
    });
    tourneyMatchAlertLater(code, match);
  }
  broadcastTourneyLater(code);
}

function startTourneyGame(room) {
  if (!room.tournament || room.game || !room.players.every((player) => player?.connected)) return;
  room.game = createGame(room.settings, 0);
  room.startedAt = Date.now();
  room.saved = false;
  room.saving = false;
  armLearn(room);
}

function resolveTourneyRoom(room, reason) {
  if (!room.tournament || room.tournament.done) return;
  const game = room.game || createGame(room.settings, 0);
  room.game = game;
  if (game.status === "playing") {
    const lead = game.scores[0] === game.scores[1] ? randomInt(0, 2) : game.scores[0] > game.scores[1] ? 0 : 1;
    game.status = "finished";
    game.winner = lead;
    game.reason = reason;
  }
  room.saved = reason === "forfeit" || reason === "absence";
  emitState(room, { type: reason });
}

function concludeTourneyMatch(room) {
  room.tournament.done = true;
  const game = room.game;
  if (game.winner !== 0 && game.winner !== 1) {
    game.winner = randomInt(0, 2);
    game.reason = "tirage";
  }
  const seat = game.winner;
  const reason = game.reason || "score";
  finishMatch({
    matchId: room.tournament.matchId,
    winner: room.players[seat].id,
    scores: game.scores.slice(0, 2),
    reason,
  }).then(async (result) => {
    if (!result) return;
    tourneyResultAlertLater(result);
    if (result.next === "start") await startTourneyMatches(result.code);
    else broadcastTourneyLater(result.code);
  }).catch((error) => console.error("Match de tournoi:", error.message));
}

function checkTourneyShowUp(room, now) {
  if (!room.tournament || room.game || now < room.tournament.showUpBy) return;
  const arrived = room.tournament.arrived || [false, false];
  const present = [0, 1].filter((seat) => arrived[seat]
    || (room.players[seat]?.connected && socketAlive(room.players[seat].socketId)));
  if (present.length === 2) {
    // Les deux sont venus : la partie commence ; un joueur coupé a le délai habituel pour revenir.
    room.game = createGame(room.settings, 0);
    room.startedAt = now;
    room.saved = false;
    room.saving = false;
    armLearn(room);
    if (!room.forfeitAt) room.forfeitAt = [null, null];
    for (const seat of [0, 1]) {
      const player = room.players[seat];
      if (player?.connected && socketAlive(player.socketId)) continue;
      if (player) player.connected = false;
      const socketId = player?.socketId || "";
      clearForfeit(room, seat);
      room.forfeitAt[seat] = now + PLAY_GRACE_MS;
      room.forfeit[seat] = setTimeout(() => {
        const holder = room.players[seat];
        if (!holder || holder.connected || holder.socketId !== socketId) return;
        if (room.game?.status === "playing") {
          abandon(room.game, seat);
          emitState(room, { type: "forfeit" });
        }
      }, PLAY_GRACE_MS);
    }
    emitState(room, { type: "start" });
    return;
  }
  room.game = createGame(room.settings, 0);
  room.game.status = "finished";
  room.game.reason = present.length === 1 ? "forfeit" : "absence";
  room.game.winner = present.length === 1 ? present[0] : randomInt(0, 2);
  room.saved = true;
  emitState(room, { type: room.game.reason });
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

let learnWatch = { at: 0, ids: new Set() };

async function learnWatchIds() {
  if (!dbReady()) return new Set();
  if (Date.now() - learnWatch.at < 60_000 && learnWatch.ids.size) return learnWatch.ids;
  const ids = await findLearnWatchIds(LEARN_NAMES);
  learnWatch = { at: Date.now(), ids: new Set(ids) };
  return learnWatch.ids;
}

function armLearn(room) {
  room.learn = { active: false, steps: [], saved: false, saving: false };
  const a = room.players?.[0]?.id;
  const b = room.players?.[1]?.id;
  if (!dbReady() || !isUuid(a) || !isUuid(b)) return;
  if (learnWatch.ids.has(a) || learnWatch.ids.has(b)) room.learn.active = true;
  learnWatchIds().then((ids) => {
    if (!room.learn) return;
    if (ids.has(a) || ids.has(b)) room.learn.active = true;
    else if (!room.learn.steps.length) room.learn.active = false;
  }).catch((error) => console.error("Learn arm:", error.message));
}

function noteLearnMove(room, seat, move) {
  const learn = room?.learn;
  if (!learn?.active || !room.game || !move) return;
  try {
    const step = learn.steps.length;
    learn.steps.push({
      step,
      seat: seat === 1 ? 1 : 0,
      r: move.r,
      c: move.c,
      after: (step + 1) % LEARN_CHECKPOINT === 0 ? boardSnap(room.game) : null,
      at: Date.now(),
    });
  } catch (error) {
    console.error("Learn move:", error.message);
  }
}

function saveLearnMatch(room) {
  const learn = room?.learn;
  const game = room?.game;
  if (!learn?.active || !game || game.status !== "finished" || learn.saved || learn.saving) return;
  if (!isUuid(room.players[0]?.id) || !isUuid(room.players[1]?.id)) return;
  learn.saving = true;
  const last = learn.steps.at(-1);
  if (last && !last.after) {
    try {
      last.after = boardSnap(game);
    } catch {
      last.after = null;
    }
  }
  const endedAt = Date.now();
  const startedAt = room.startedAt || endedAt;
  const winner = game.winner === 0 || game.winner === 1 || game.winner === "0" || game.winner === "1"
    ? String(Number(game.winner))
    : "draw";
  const entry = {
    id: randomUUID(),
    fingerprint: learnFingerprint(room.players[0].id, room.players[1].id, startedAt, game.rows, game.cols),
    roomCode: room.code || "",
    player0Id: room.players[0].id,
    player1Id: room.players[1].id,
    player0Name: cleanName(room.players[0].name, "Joueur 1"),
    player1Name: cleanName(room.players[1].name, "Joueur 2"),
    startedAt,
    endedAt,
    durationMs: Math.max(1, Math.round(endedAt - startedAt)),
    rows: game.rows,
    cols: game.cols,
    starter: game.starter === 1 ? 1 : 0,
    scores: [Number(game.scores[0]) || 0, Number(game.scores[1]) || 0],
    winner,
    reason: game.reason ? String(game.reason).slice(0, 24) : null,
    settings: room.settings || {},
    moveCount: learn.steps.length,
    moves: learn.steps,
  };
  insertLearnMatch(entry).then(async (result) => {
    learn.saved = true;
    learn.steps = [];
    if (!result?.duplicate) startLearnAnalysis(5);
  }).catch((error) => {
    console.error("Learn save:", error.message);
    learn.saved = false;
  }).finally(() => {
    learn.saving = false;
  });
}

let learnAnalyzing = false;

function playingRooms() {
  let n = 0;
  for (const room of rooms.values()) if (room.game?.status === "playing") n += 1;
  return n;
}

/** Lance l'analyse en arrière-plan si rien ne tourne déjà. Renvoie false si une analyse est en cours. */
function startLearnAnalysis(limit, options = {}) {
  if (learnAnalyzing || !dbReady()) return false;
  learnAnalyzing = true;
  analyzePendingLearnMatches(limit, options)
    .catch((error) => console.error("Learn analyse:", error.message))
    .finally(() => {
      learnAnalyzing = false;
    });
  return true;
}

// Rattrapage tranquille : toutes les 2 minutes, 2 parties au plus, seulement quand peu de matchs tournent.
setInterval(() => {
  if (playingRooms() <= 3) startLearnAnalysis(2);
}, 2 * 60 * 1000).unref();

async function analyzePendingLearnMatches(limit = 40, { recordRun = false } = {}) {
  if (!dbReady()) return { analyzed: 0, situations: 0 };
  const ids = await listLearnMatchesNeedingAnalysis(limit);
  let analyzed = 0;
  let situations = 0;
  try {
    for (const id of ids) {
      try {
        const match = await getLearnMatch(id);
        if (!match) continue;
        const found = await runLearnJob("analyze", match);
        situations += await replaceLearnSituations(id, found);
        analyzed += 1;
      } catch (error) {
        console.error("Learn analyze:", error.message);
      }
    }
    if (recordRun) {
      const overview = await learnOverview();
      await insertLearnRun({
        kind: analyzed || situations ? "analyse" : "collecte",
        status: "ok",
        modelVersion: overview.model?.activeVersion || "v1",
        matches: overview.matches,
        moves: overview.moves,
        situations: overview.situations?.total || 0,
        report: overview.report,
        detail: { analyzed, situationsAdded: situations },
      });
    }
  } catch (error) {
    if (recordRun) {
      await insertLearnRun({
        kind: "echec",
        status: "echec",
        modelVersion: "v1",
        report: error.message,
        detail: { error: error.message },
      }).catch(() => {});
      await updateLearnMeta({ status: "echec", lastError: error.message }).catch(() => {});
    }
    throw error;
  }
  return { analyzed, situations };
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

const WATCH_LIMIT = 30;

function watchChannel(code) {
  return `watch:${code}`;
}

function watchSnapshot(room, event = null) {
  return {
    match: room.matchId || "",
    game: room.game,
    settings: { p1Color: room.settings.p1Color, p2Color: room.settings.p2Color, p1Name: room.settings.p1Name, p2Name: room.settings.p2Name },
    seats: room.players.map((player) => (player ? { name: player.name, color: player.color, connected: player.connected } : null)),
    tournament: room.tournament ? { round: room.tournament.round } : null,
    event: event && ["move", "timeout", "skip", "golden", "start", "forfeit", "abandon", "time"].includes(event.type) ? event : null,
    watchers: io.sockets.adapter.rooms.get(watchChannel(room.code))?.size || 0,
  };
}

function emitWatch(room, event) {
  const channel = watchChannel(room.code);
  if (!io.sockets.adapter.rooms.get(channel)?.size) return;
  io.to(channel).emit("watch-state", watchSnapshot(room, event));
}

function emitState(room, event = null) {
  room.touched = Date.now();
  startTourneyGame(room);
  if (room.tournament && !room.tournament.done && room.game?.status === "finished") concludeTourneyMatch(room);
  if (room.game?.status === "finished") {
    saveOnlineMatch(room);
    saveLearnMatch(room);
  }
  const paired = pairState(room);
  if (paired === "playing" && room.game) {
    const score = room.game.scores.slice(0, 2).join("-");
    if (room.findScore !== score) {
      room.findScore = score;
      broadcastFindSoon();
    }
  }
  if (room.listed !== paired) {
    room.listed = paired;
    setImmediate(broadcastFind);
  }
  emitWatch(room, event);
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
  const activity = ["robot", "duo", "local"].includes(payload.activity) ? payload.activity : "";
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
      // « lobby » : seul dans sa salle en ligne, en attente d'un adversaire.
      const activity = paired || phase === "playing"
        ? "duo"
        : phase === "waiting"
          ? "lobby"
          : phase === "finished"
            ? ""
            : (["robot", "duo", "local"].includes(item.activity) ? item.activity : "");
      const seat = paired ? room.players.findIndex((player) => player?.socketId === item.socketId) : -1;
      return {
        token: item.token,
        name: item.name,
        photo: item.photo,
        busy: paired ? true : phase === "finished" ? false : accountBusy(item) || activity !== "",
        activity,
        match: paired ? room.matchId : "",
        matchState: paired,
        seat,
        scores: paired && room.game ? [Number(room.game.scores[0]) || 0, Number(room.game.scores[1]) || 0] : null,
      };
    })
    .sort((a, b) => Number(a.busy) - Number(b.busy) || a.name.localeCompare(b.name, "fr"))
    .slice(0, 40);
}

let findTimer = null;

function broadcastFindSoon() {
  if (findTimer) return;
  findTimer = setTimeout(() => {
    findTimer = null;
    broadcastFind();
  }, 1000);
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
  io.to(watchChannel(room.code)).emit("watch-end", { match: room.matchId || "" });
  io.in(watchChannel(room.code)).socketsLeave(watchChannel(room.code));
  rooms.delete(room.code);
}

function reapRooms() {
  const now = Date.now();
  for (const [code, room] of rooms) {
    for (const player of room.players) {
      if (player && !socketAlive(player.socketId)) player.connected = false;
    }
    const anyone = room.players.some((player) => player?.connected && socketAlive(player.socketId));
    if (room.tournament) {
      if (!room.tournament.done && room.game?.status === "playing" && !anyone && now - room.touched > PLAY_GRACE_MS) {
        resolveTourneyRoom(room, "absence");
      }
      if (room.tournament.done && !anyone && now - room.touched > 60_000) rooms.delete(code);
      continue;
    }
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
  if (room.tournament && !room.game) {
    room.players[seat].connected = false;
    room.players[seat].socketId = "";
    emitState(room, { type: "left" });
    return;
  }
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
    const prior = liveRoom(socket);
    if (prior && prior.room.code !== room.code && prior.room.game?.status === "finished") leaveRoom(socket);
    const key = playerKey(socket, payload.playerId);
    const existing = seatOf(room, key);
    if (existing >= 0) {
      const holder = room.players[existing];
      if (holder.connected && holder.socketId !== socket.id) {
        const sameAccount = Boolean(socket.data.account) && socket.data.account === key;
        if (!sameAccount) return ack?.({ ok: false, error: "Ce joueur est déjà dans la salle." });
        const previous = io.sockets.sockets.get(holder.socketId);
        if (previous) {
          previous.leave(room.code);
          previous.data.roomCode = "";
        }
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
    noteLearnMove(room, seat, play);
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
    if (!room?.game || seat < 0 || room.game.status !== "finished" || room.tournament) return;
    room.rematch[seat] = true;
    if (room.rematch[0] && room.rematch[1]) {
      const starter = room.game.starter === 0 ? 1 : 0;
      room.game = createGame(room.settings, starter);
      room.startedAt = Date.now();
      room.saved = false;
      room.saving = false;
      room.rematch = [false, false];
      armLearn(room);
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
    if (!room || seat !== 0 || room.game || room.tournament || limited(`${socket.id}:table`, 20, 60_000)) return;
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
    armLearn(room);
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

  socket.on("watch", (payload = {}, ack) => {
    payload = asObject(payload);
    if (limited(`${socket.id}:watch`, 20, 60_000)) return ack?.({ ok: false, error: "Trop d'essais. Patiente un peu." });
    const match = String(payload.match || "");
    const room = match ? [...rooms.values()].find((item) => item.matchId === match) : null;
    if (!room || pairState(room) !== "playing") return ack?.({ ok: false, error: "Ce match n’est plus en cours." });
    if (liveRoom(socket)) return ack?.({ ok: false, error: "Quitte d’abord ta partie pour regarder un match." });
    if (room.players.some((player) => player?.socketId === socket.id)) return ack?.({ ok: false, error: "Tu joues déjà ce match." });
    const channel = watchChannel(room.code);
    if ((io.sockets.adapter.rooms.get(channel)?.size || 0) >= WATCH_LIMIT) return ack?.({ ok: false, error: "Trop de spectateurs sur ce match." });
    if (socket.data.watching && socket.data.watching !== room.code) socket.leave(watchChannel(socket.data.watching));
    socket.data.watching = room.code;
    socket.join(channel);
    ack?.({ ok: true, state: watchSnapshot(room) });
  });

  socket.on("unwatch", () => {
    if (!socket.data.watching) return;
    socket.leave(watchChannel(socket.data.watching));
    socket.data.watching = "";
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
      if (seat === 1 && !room.tournament) {
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
  if (room.tournament && !room.game) noteTourneyArrival(room, seat);
}

/** Un joueur est arrivé à son match : on le retient, et on prévient l'autre s'il n'est pas encore là. */
function noteTourneyArrival(room, seat) {
  const t = room.tournament;
  if (!t.arrived) t.arrived = [false, false];
  t.arrived[seat] = true;
  const other = 1 - seat;
  if (t.arrived[other] || t.waitingSent) return;
  t.waitingSent = true;
  const otherId = room.players[other]?.id;
  const left = Math.max(0, t.showUpBy - Date.now());
  const round = { quarter: "quart de finale", semi: "demi-finale", final: "finale" }[t.round] || "match";
  tourneyAlertsLater(async () => {
    const people = await tourneyPeople(t.code);
    if (!people || !isUuid(otherId)) return;
    await tourneyAlert(otherId, {
      code: t.code,
      ref: `${t.code}:${t.matchId}:waiting`,
      title: `${room.players[seat]?.name || "Ton adversaire"} t’attend`,
      body: `Ta ${round} de « ${people.name} » : rejoins-le vite, il te reste environ ${durationText(left)}.`,
    }, true);
  });
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
      if (clock.timedOut && clock.kind === "turn" && room.tournament) {
        skipTurn(room.game);
        emitState(room, { type: "skip" });
      } else if (clock.timedOut && clock.kind === "golden") {
        emitState(room, { type: "golden" });
      } else if (clock.timedOut && clock.kind === "turn") {
        const moves = legalMoves(room.game);
        if (moves.length) {
          const move = moves[Math.floor(Math.random() * moves.length)];
          const seat = room.game.current;
          const result = applyMove(room.game, move);
          if (result.ok) noteLearnMove(room, seat, move);
          emitState(room, { type: "timeout", move, result });
        }
      } else if (clock.timedOut && clock.kind === "global") {
        emitState(room, { type: "time" });
      }
    } else {
      room.clockAt = now;
      checkTourneyShowUp(room, now);
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
    if (dbReady()) {
      learnWatchIds().catch(() => {});
      resetPlayingMatches()
        .then((codes) => Promise.all(codes.map((code) => startTourneyMatches(code))))
        .catch((error) => console.error("Reprise des tournois:", error.message));
    }
  });
