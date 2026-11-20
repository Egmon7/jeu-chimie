import { chooseMove } from "./ai.js";
import { Sounds } from "./audio.js";
import {
  abandon,
  applyMove,
  canCatch,
  closeByHand,
  createGame,
  formatClock,
  legalMoves,
  moveInfo,
  normalizeSettings,
  sheetHouseCap,
  tick,
  COLORS,
  REACTIONS,
} from "./engine.js";
import { BoardView, displayColor } from "./render.js";
import {
  clearHistory,
  loadHistory,
  loadPrefs,
  loadProfile,
  loadSession,
  playerId,
  pushHistory,
  replaceHistory,
  savePrefs,
  saveProfile,
  saveSession,
  setPlayerId,
} from "./storage.js";

document.body.classList.add("ready");

const DIFF_LABEL = {
  easy: "Facile",
  medium: "Moyen",
  hard: "Difficile",
  veryhard: "Très difficile",
  expert: "Expert",
};

const COLOR_LABEL = {
  red: "Rouge",
  blue: "Bleu",
  black: "Noir",
  green: "Vert",
  purple: "Violet",
  orange: "Orange",
};

const REASON = {
  board: "Tous les points ont été posés.",
  score: "L’objectif de score est atteint.",
  time: "Le temps global est écoulé.",
  abandon: "Un joueur a abandonné.",
  robot: "Le robot abandonne.",
};

const ROBOT_GAP = {
  easy: [6, 10],
  medium: [7, 12],
  hard: [8, 15],
  veryhard: [10, 18],
  expert: [12, 22],
};

const app = {
  prefs: loadPrefs(),
  mode: null,
  formMode: "solo",
  game: null,
  players: [],
  seat: 0,
  paused: false,
  inputLock: false,
  timeoutQueued: null,
  recorded: false,
  rematchOffer: "",
  ignoreOnline: false,
  starterFlip: 0,
  lastTs: 0,
  clockSync: null,
  socket: null,
  roomCode: null,
  queued: false,
  admin: false,
  sounds: new Sounds(),
  board: null,
};

const $ = (id) => document.getElementById(id);

const SCREEN_BY_PAGE = {
  home: "screen-home",
  modes: "screen-modes",
  setup: "screen-setup",
  online: "screen-online",
  find: "screen-find",
  lobby: "screen-lobby",
  game: "screen-game",
  history: "screen-history",
  profile: "screen-profile",
  progress: "screen-progress",
  rank: "screen-rank",
  badges: "screen-badges",
  admin: "screen-admin",
};

const SHELL_PAGES = new Set(["home", "modes", "setup", "profile", "progress", "rank", "badges", "history", "admin"]);

function pageOf(id) {
  return Object.keys(SCREEN_BY_PAGE).find((key) => SCREEN_BY_PAGE[key] === id) || "home";
}

function show(id, historyMode = "push") {
  document.querySelectorAll(".screen").forEach((screen) => {
    screen.hidden = screen.id !== id;
  });
  const page = pageOf(id);
  document.body.dataset.page = SHELL_PAGES.has(page) ? page : "play";
  applyTheme(id === "screen-game" ? app.prefs.theme : "classic");
  if (id === "screen-game") {
    const wrap = document.querySelector(".board-wrap");
    if (app.game && wrap) {
      wrap.style.setProperty("--sheet-w", String(app.game.cols));
      wrap.style.setProperty("--sheet-h", String(app.game.rows));
    }
    requestAnimationFrame(() => {
      app.board.resize();
      fitSheet();
    });
  }
  if (id !== "screen-game") {
    const chatBtn = $("chat-open");
    cancelVoice();
    if (chatBtn) {
      chatBtn.hidden = true;
      const panel = $("chat-panel");
      if (panel) panel.hidden = true;
      chatBtn.setAttribute("aria-expanded", "false");
    }
  }
  if (id === "screen-profile") {
    fillProfileForm(loadProfile());
    pullProfile();
  }
  if (app.queued && id !== "screen-find") {
    app.queued = false;
    app.socket?.emit("queue-leave");
  }
  if (id === "screen-online") {
    const name = (loadProfile().name || "").trim();
    const label = $("join-name").closest("label");
    if (name) $("join-name").value = name;
    if (label) label.hidden = Boolean(name);
  }
  if (id === "screen-find") enterQueue();
  if (id === "screen-progress") loadProgress();
  if (id === "screen-rank") loadRanking();
  if (id === "screen-badges") renderBadgeCatalog();
  if (id === "screen-history") pullHistory();
  if (id === "screen-admin") loadAdmin();
  else stopAdminWatch();
  if (id === "screen-modes") openHub(savedHub());
  if (historyMode === "skip") return;
  const url = page === "home"
    ? `${location.pathname}${location.search}`
    : `${location.pathname}${location.search}#${page}`;
  const entry = { page };
  if (page === "online" || page === "find" || page === "lobby" || (page === "setup" && app.formMode === "online") || (page === "game" && app.mode === "online")) {
    entry.flow = "online";
  }
  if (historyMode === "replace" || history.state?.page === page) history.replaceState(entry, "", url);
  else history.pushState(entry, "", url);
}

function closeGameMenu() {
  const menu = $("game-menu");
  if (!menu) return;
  menu.hidden = true;
  $("game-menu-btn").setAttribute("aria-expanded", "false");
}

function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove("show"), 2800);
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
}

function applyTheme(theme) {
  document.body.dataset.theme = theme === "light" ? "light" : "classic";
}

function readGroup(field) {
  return document.querySelector(`[data-field="${field}"] [aria-pressed="true"]`)?.dataset.value ?? null;
}

function setGroup(field, value) {
  const root = document.querySelector(`[data-field="${field}"]`);
  if (!root) return;
  let matched = false;
  root.querySelectorAll("[data-value]").forEach((btn) => {
    const on = btn.dataset.value === String(value);
    if (on) matched = true;
    btn.setAttribute("aria-pressed", on ? "true" : "false");
  });
  if (!matched) {
    const first = root.querySelector("[data-value]");
    if (first) first.setAttribute("aria-pressed", "true");
  }
}

function readSettingsFromForm() {
  const size = document.querySelector('[data-field="size"] [aria-pressed="true"]');
  const custom = size?.dataset.value === "custom";
  const rows = custom ? Number($("rows").value) : Number(size?.dataset.rows);
  const cols = custom ? Number($("cols").value) : Number(size?.dataset.cols);
  const scoreMode = readGroup("score");
  const scoreLimit = scoreMode === "custom" ? Number($("scoreLimit").value) : Number(scoreMode);
  let opponent = app.formMode;
  if (app.formMode === "custom") opponent = readGroup("opponent") || "solo";
  const soloName = app.formMode === "solo" || (app.formMode === "custom" && opponent === "solo");
  return {
    settings: normalizeSettings({
      rows,
      cols,
      extraTurn: readGroup("rule") !== "once",
      timeMode: readGroup("timeMode"),
      timeLimit: Number($("timeLimit").value),
      scoreLimit,
      p1Color: readGroup("p1Color"),
      p2Color: readGroup("p2Color"),
      penStyle: "fine",
      theme: readGroup("theme"),
      difficulty: readGroup("difficulty"),
      sound: app.prefs.sound,
      closeMode: readGroup("closeMode"),
      p1Name: $("p1Name").value,
      p2Name: soloName ? "Robot" : $("p2Name").value,
    }),
    opponent,
  };
}

function fillForm(prefs) {
  const key = `${prefs.rows}-${prefs.cols}`;
  if (["32-24", "32-18"].includes(key)) setGroup("size", key);
  else if (["20-17", "16-12"].includes(key)) setGroup("size", "32-24");
  else {
    setGroup("size", "custom");
    $("rows").value = prefs.rows;
    $("cols").value = prefs.cols;
  }
  setGroup("rule", prefs.extraTurn === false ? "once" : "extra");
  setGroup("timeMode", prefs.timeMode || "none");
  $("timeLimit").value = prefs.timeLimit || 300;
  if ([0, 5, 10, 20].includes(Number(prefs.scoreLimit))) setGroup("score", String(prefs.scoreLimit));
  else {
    setGroup("score", "custom");
    $("scoreLimit").value = prefs.scoreLimit;
  }
  setGroup("p1Color", prefs.p1Color === "orange" ? "blue" : prefs.p1Color);
  setGroup("p2Color", prefs.p2Color === "orange" ? "red" : prefs.p2Color);
  syncPenColors("p1Color");
  setGroup("theme", prefs.theme);
  setGroup("difficulty", prefs.difficulty);
  setGroup("closeMode", prefs.closeMode === "hand" ? "hand" : "auto");
  $("p1Name").value = prefs.p1Name || "Joueur 1";
  $("p2Name").value = !prefs.p2Name || prefs.p2Name === "Robot" ? "Joueur 2" : prefs.p2Name;
  syncFormBits();
}

function otherPen(field) {
  if (field === "p1Color") return "p2Color";
  if (field === "p2Color") return "p1Color";
  return null;
}

function syncPenColors(changedField) {
  const other = otherPen(changedField);
  if (!other) return;
  const chosen = readGroup(changedField);
  if (readGroup(other) === chosen) {
    const next = document.querySelector(`[data-field="${other}"] [data-value]:not([data-value="${chosen}"])`);
    if (next) setGroup(other, next.dataset.value);
  }
  for (const field of ["p1Color", "p2Color"]) {
    const taken = readGroup(otherPen(field));
    document.querySelectorAll(`[data-field="${field}"] [data-value]`).forEach((btn) => {
      btn.disabled = btn.dataset.value === taken;
    });
  }
}

function sheetFromForm() {
  const size = document.querySelector('[data-field="size"] [aria-pressed="true"]');
  const custom = size?.dataset.value === "custom";
  const rows = custom ? Number($("rows").value) : Number(size?.dataset.rows);
  const cols = custom ? Number($("cols").value) : Number(size?.dataset.cols);
  return { rows, cols, cap: sheetHouseCap(rows, cols) };
}

function syncScoreCap() {
  const { cap } = sheetFromForm();
  const note = $("score-cap");
  if (note) note.textContent = `Cette feuille peut contenir au plus ${cap} maisons.`;
  const input = $("scoreLimit");
  if (input) {
    input.max = String(cap);
    if (Number(input.value) > cap) input.value = String(cap);
  }
  document.querySelectorAll('[data-field="score"] [data-value]').forEach((btn) => {
    const value = Number(btn.dataset.value);
    const over = Number.isFinite(value) && value > cap;
    btn.disabled = over;
    if (over && btn.getAttribute("aria-pressed") === "true") {
      const fallback = ["20", "10", "5", "0"].find((item) => Number(item) <= cap) || "0";
      setGroup("score", fallback);
    }
  });
}

function markTimePreset() {
  const seconds = String(Number($("timeLimit").value) || 300);
  document.querySelectorAll("[data-set-time]").forEach((btn) => {
    btn.setAttribute("aria-pressed", btn.dataset.setTime === seconds ? "true" : "false");
  });
}

function foldName(value) {
  return String(value ?? "").normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase("fr");
}

function syncFormBits() {
  $("custom-size").hidden = readGroup("size") !== "custom";
  const timeMode = readGroup("timeMode");
  $("time-box").hidden = timeMode === "none";
  markTimePreset();
  $("score-custom").hidden = readGroup("score") !== "custom";
  syncScoreCap();
  document.querySelectorAll("[data-show]").forEach((el) => {
    el.hidden = !el.dataset.show.split(" ").includes(app.formMode);
  });
  const profileName = (loadProfile().name || "").trim();
  const ownName = $("p1Name")?.closest("[data-show]");
  if (ownName && profileName && !ownName.hidden) {
    ownName.hidden = true;
    $("p1Name").value = profileName;
  }
  const titles = {
    solo: ["Robot", "Réglez la feuille, puis affrontez un robot."],
    local: ["Multijoueurs", "Même écran, deux stylos."],
    online: ["Créer une salle", "Choisis les règles. Le code s’affiche ensuite."],
    custom: ["Partie libre", "Taille, temps, score et adversaire."],
  };
  const [title, lead] = titles[app.formMode];
  $("setup-title").textContent = title;
  $("setup-lead").textContent = lead;
  const labels = {
    solo: "Lancer la partie",
    local: "Lancer la partie",
    online: "Créer la salle",
    custom: "Lancer la partie",
  };
  $("setup-go").textContent = labels[app.formMode];
}

const MATCH_KEY = "egmon-live-match";

function saveMatch() {
  if (app.mode !== "solo" && app.mode !== "local") return;
  try {
    if (!app.game || app.game.status !== "playing") {
      sessionStorage.removeItem(MATCH_KEY);
      return;
    }
    sessionStorage.setItem(MATCH_KEY, JSON.stringify({
      mode: app.mode,
      players: app.players,
      game: app.game,
    }));
  } catch {
    /* la partie continue même si le navigateur refuse le stockage */
  }
}

function restoreMatch() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(MATCH_KEY) || "null");
    if (!saved?.game || saved.game.status !== "playing") return false;
    if (saved.mode !== "solo" && saved.mode !== "local") return false;
    if (!Array.isArray(saved.game.dots) || !Array.isArray(saved.players) || saved.players.length !== 2) return false;
    app.mode = saved.mode;
    app.players = saved.players;
    app.game = saved.game;
    app.seat = 0;
    app.paused = false;
    app.inputLock = false;
    app.recorded = false;
    app.timeoutQueued = null;
    resetSheetZoom();
    show("screen-game", "replace");
    paintMatch();
    hideOverlay();
    if (app.mode === "solo" && app.players[app.game.current]?.kind === "ai") queueAi();
    return true;
  } catch {
    sessionStorage.removeItem(MATCH_KEY);
    return false;
  }
}

function openSetup(mode, historyMode = "push") {
  app.formMode = mode;
  try { sessionStorage.setItem("egmon-setup-mode", mode); } catch { /* ignore */ }
  fillForm(app.prefs);
  $("p1Name").value = (loadProfile().name || "").trim();
  $("p2Name").value = "";
  $("setup-go").textContent = mode === "online" ? "Créer la salle" : "Lancer la partie";
  show("screen-setup", historyMode === "skip" ? "skip" : mode === "online" ? "replace" : historyMode);
}

const CLOUD_NAME = "ka4h4lpk";
const CLOUD_PRESET = "jeu-chimie";
const CLOUD_PHOTO = /^https:\/\/res\.cloudinary\.com\/ka4h4lpk\/image\/upload\/[A-Za-z0-9_./%-]{1,360}$/;
const PROFILE_PHOTO_MAX = 96;
const FACE_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="3.2"></circle><path d="M5 19c1.4-3 3.6-4.5 7-4.5S17.6 16 19 19"></path></svg>`;

function photoView(url, size = 192) {
  return url.replace("/image/upload/", `/image/upload/c_fill,g_auto,f_auto,q_auto,w_${size},h_${size}/`);
}

function faceMarkup(photo, eager = false) {
  if (!CLOUD_PHOTO.test(photo)) return FACE_ICON;
  const wait = eager ? `fetchpriority="high"` : `loading="eager"`;
  return `<img src="${photoView(photo, 96)}" alt="" width="96" height="96" decoding="async" ${wait} referrerpolicy="no-referrer">`;
}

function bindFaceImages(root) {
  root?.querySelectorAll(".face img").forEach((img) => {
    img.addEventListener("error", () => {
      img.replaceWith(document.createRange().createContextualFragment(FACE_ICON));
    }, { once: true });
  });
}

function fillProfileForm(profile) {
  $("profile-name").value = profile.name || "";
  $("profile-email").value = profile.email || "";
  $("profile-password").value = "";
  $("profile-confirm").value = "";
  const photo = $("profile-photo");
  const url = CLOUD_PHOTO.test(profile.photo) ? profile.photo : "";
  photo.hidden = !url;
  photo.dataset.full = url;
  photo.src = url ? photoView(url) : "";
  photo.style.width = `${PROFILE_PHOTO_MAX}px`;
  photo.style.height = `${PROFILE_PHOTO_MAX}px`;
}

async function shrinkPhoto(file) {
  const bitmap = await createImageBitmap(file);
  const max = 320;
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.72));
  if (!blob) throw new Error("photo");
  return blob;
}

async function uploadProfilePhoto(file) {
  const button = $("photo-btn");
  const label = $("photo-label");
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
    toast("Choisis une image jpg, png ou webp.");
    return;
  }
  if (file.size > 2 * 1024 * 1024) {
    toast("La photo doit rester sous 2 Mo.");
    return;
  }
  const photo = $("profile-photo");
  const status = $("photo-status");
  const previous = photo.dataset.full || "";
  const preview = URL.createObjectURL(file);
  photo.hidden = false;
  photo.src = preview;
  photo.style.width = `${PROFILE_PHOTO_MAX}px`;
  photo.style.height = `${PROFILE_PHOTO_MAX}px`;
  label.textContent = "Préparation…";
  if (status) status.textContent = "Aperçu affiché. La photo est réduite avant l’envoi.";
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  button.classList.add("is-busy");
  label.textContent = "Envoi…";
  try {
    const blob = file.type === "image/jpeg" && file.size <= 90_000 ? file : await shrinkPhoto(file);
    const body = new FormData();
    body.append("file", blob, "photo.jpg");
    body.append("upload_preset", CLOUD_PRESET);
    const res = await fetch(`https://api.cloudinary.com/v1_1/${CLOUD_NAME}/image/upload`, { method: "POST", body });
    const data = await res.json();
    const url = String(data?.secure_url || "");
    if (!res.ok || !CLOUD_PHOTO.test(url)) throw new Error("photo");
    const saved = saveProfile({ ...loadProfile(), photo: url });
    announcePresence();
    fillProfileForm(saved);
    if (saved.name) syncProfile(saved);
    if (status) status.textContent = "Photo enregistrée.";
    toast("Photo enregistrée.");
  } catch {
    photo.src = previous ? photoView(previous) : "";
    photo.hidden = !previous;
    photo.dataset.full = previous;
    if (status) status.textContent = "La photo n’a pas pu partir. Réessaie.";
    toast("La photo n’a pas pu partir.");
  } finally {
    URL.revokeObjectURL(preview);
    button.classList.remove("is-busy");
    label.textContent = "Choisir une photo";
  }
}

function iconMarkup(icon) {
  const source = document.querySelector(`#icon-sprite [data-icon="${icon}"]`);
  return source ? source.outerHTML : "";
}

const LEVELS = [
  { xp: 0, name: "Élève", icon: "dot" },
  { xp: 150, name: "Stylo", icon: "pen" },
  { xp: 500, name: "Cahier", icon: "book" },
  { xp: 1200, name: "Bâtisseur", icon: "house" },
  { xp: 2500, name: "Étoile", icon: "star" },
  { xp: 5000, name: "Losange", icon: "gem" },
  { xp: 8000, name: "Flamme", icon: "flame" },
  { xp: 12000, name: "Copiste", icon: "pen" },
  { xp: 18000, name: "Archiviste", icon: "book" },
  { xp: 24000, name: "Maître", icon: "house" },
  { xp: 30000, name: "Couronne", icon: "crown" },
];

const RANK_TITLE = {
  1: "Premier de la classe",
  2: "Second de la classe",
  3: "Troisième de la classe",
};

function levelOf(xp) {
  let current = LEVELS[0];
  for (const level of LEVELS) if (xp >= level.xp) current = level;
  const next = LEVELS.find((level) => level.xp > xp) || null;
  return { ...current, next };
}

function earnedBadges(row) {
  return BADGE_GOALS.filter((item) => item.test(row)).map((item) => item.name);
}

const BADGE_GOALS = [
  { name: "Première maison", need: "Fermer une maison", img: "img/badges/master.png", test: (row) => (Number(row.houses) || 0) >= 1 },
  { name: "Première victoire", need: "Gagner une partie", img: "img/badges/man-winner.png", test: (row) => (Number(row.wins) || 0) >= 1 },
  { name: "Dix victoires", need: "Gagner 10 parties", img: "img/badges/gaming-hand.png", test: (row) => (Number(row.wins) || 0) >= 10 },
  { name: "Dix maisons", need: "Fermer 10 maisons", img: "img/badges/medal-tv.png", test: (row) => (Number(row.houses) || 0) >= 10 },
  { name: "500 maisons", need: "Fermer 500 maisons", img: "img/badges/discord.png", test: (row) => (Number(row.houses) || 0) >= 500 },
  { name: "1000 maisons", need: "Fermer 1000 maisons", img: "img/badges/medal.png", test: (row) => (Number(row.houses) || 0) >= 1000 },
  { name: "Habitué", need: "Finir 100 parties", img: "img/badges/police-badge.png", test: (row) => (Number(row.games) || 0) >= 100 },
  { name: "Régulier", need: "Finir 300 parties", img: "img/badges/baseball.png", test: (row) => (Number(row.games) || 0) >= 300 },
  { name: "Expert battu", need: "Battre 50 fois l'expert", img: "img/badges/legend.png", test: (row) => (Number(row.expertWins) || 0) >= 50 },
  { name: "Grande feuille", need: "100 maisons dans une partie", img: "img/badges/premium-badge.png", test: (row) => (Number(row.best) || 0) >= 100 },
];

const CHALLENGES = [
  { id: "speed", name: "Moins de 8 minutes", text: "Fermer 10 maisons en moins de 8 minutes.", xp: 40, test: (games) => games.some((game) => game.durationMs >= 1000 && game.durationMs <= 8 * 60 * 1000 && housesOf(game) >= 10) },
  { id: "precision", name: "Précision", text: "Fermer une maison à la main, sans erreur.", xp: 50, test: (games) => games.some((game) => game.clean === true) },
  { id: "dominate", name: "Domination", text: "Gagner en prenant au moins 10 maisons.", xp: 45, test: (games) => games.some((game) => wonGame(game) && housesOf(game) >= 10) },
  { id: "comeback", name: "Remontée", text: "Gagner après avoir été mené au score.", xp: 60, test: (games) => games.some((game) => game.behind === true && wonGame(game)) },
  { id: "streak", name: "Série de 3 jours", text: "Jouer trois jours de suite.", xp: 30, test: (games) => playStreak(games) >= 3 },
  { id: "expert", name: "Expert", text: "Affronter le robot au niveau expert.", xp: 35, test: (games) => games.some((game) => game.difficulty === "expert") },
  { id: "blank", name: "Feuille blanche", text: "Gagner sans laisser une maison à l’autre.", xp: 55, test: (games) => games.some((game) => wonGame(game) && housesOf(game, 1) === 0 && housesOf(game) > 0) },
  { id: "week", name: "Série de 7 jours", text: "Jouer sept jours de suite.", xp: 40, test: (games) => playStreak(games) >= 7 },
];

function soloGames(games = loadHistory()) {
  return (games || []).filter((game) => game.mode === "solo" && Number(game.userSeat) === 0);
}

function housesOf(game, seat = 0) {
  const scores = game.scores;
  const value = Array.isArray(scores) ? scores[seat] : scores?.[seat];
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function wonGame(game) {
  return String(game.winner) === "0";
}

function parisKey(date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function shiftKey(key, delta) {
  const [year, month, day] = key.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

function streakProgress(need, games = loadHistory()) {
  const keys = new Set(soloGames(games).map((game) => parisKey(new Date(game.at))));
  const today = parisKey(new Date());
  const doneToday = keys.has(today);
  let cursor = doneToday ? today : shiftKey(today, -1);
  let run = 0;
  while (keys.has(cursor)) {
    run += 1;
    cursor = shiftKey(cursor, -1);
  }
  return { run, doneToday, remaining: Math.max(0, need - run) };
}

function streakLine(need, games) {
  const progress = streakProgress(need, games);
  if (progress.remaining <= 0) return "Série complète.";
  if (progress.run > 0) {
    return `Jour ${progress.run} passé. Il reste ${progress.remaining} jour${progress.remaining > 1 ? "s" : ""}.`;
  }
  return `Il reste ${need} jours.`;
}

function playStreak(games) {
  const keys = [...new Set(soloGames(games).map((game) => new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(game.at))))].sort();
  let best = 0;
  let run = 0;
  let prev = null;
  for (const key of keys) {
    const [year, month, day] = key.split("-").map(Number);
    const cur = Date.UTC(year, month - 1, day);
    run = prev != null && cur - prev === 86400000 ? run + 1 : 1;
    prev = cur;
    best = Math.max(best, run);
  }
  return best;
}

function earnedChallengeIds(games = loadHistory()) {
  const rows = soloGames(games);
  return new Set(CHALLENGES.filter((item) => item.test(rows)).map((item) => item.id));
}

function challengeBonus(games = loadHistory()) {
  const earned = earnedChallengeIds(games);
  return CHALLENGES.reduce((sum, item) => sum + (earned.has(item.id) ? item.xp : 0), 0);
}

function renderChallenges() {
  const box = $("challenge-list");
  if (!box) return;
  box.innerHTML = CHALLENGES.map((item) => {
    const extra = item.id === "streak" ? ` ${streakLine(3)}` : item.id === "week" ? ` ${streakLine(7)}` : "";
    return `<button type="button" class="challenge-card" data-challenge="${esc(item.id)}"><strong>${esc(item.name)}</strong><span>+${item.xp} XP</span><p>${esc(item.text)}${esc(extra)}</p><em>Jouez une partie</em></button>`;
  }).join("");
  const status = $("challenge-status");
  if (status) status.textContent = "";
}

function startChallenge(id) {
  const item = CHALLENGES.find((entry) => entry.id === id);
  if (!item) return;
  const name = loadProfile().name;
  if (!name) {
    toast("Écris d’abord ton nom de profil.");
    openProfile();
    return;
  }
  const need = item.id === "week" ? 7 : item.id === "streak" ? 3 : 0;
  if (need) {
    const progress = streakProgress(need);
    if (progress.doneToday || progress.remaining === 0) {
      askDialog({
        kicker: "Défi",
        title: progress.remaining === 0 ? "Défi gagné" : "Série en cours",
        text: streakLine(need),
        confirm: "Compris",
      });
      return;
    }
  }
  const previous = loadPrefs();
  const settings = normalizeSettings({
    ...app.prefs,
    p1Name: name,
    p2Name: "Robot",
    closeMode: item.id === "precision" ? "hand" : app.prefs.closeMode,
    difficulty: item.id === "expert" ? "expert" : app.prefs.difficulty,
    scoreLimit: item.id === "dominate" ? 10 : item.id === "speed" ? 0 : app.prefs.scoreLimit,
    timeMode: item.id === "speed" ? "none" : app.prefs.timeMode,
  });
  startMatch(settings, "solo");
  app.prefs = previous;
  savePrefs(previous);
  app.challengeId = item.id;
  app.challengeMs = 0;
  app.challengeVerdict = null;
}

function renderProgress(rows) {
  const youBox = $("rank-you");
  const known = Array.isArray(rows);
  const mine = known ? rows.find((row) => row.you) : null;
  const player = mine || { xp: 0, best: 0, name: loadProfile().name || "Toi", rank: 0, houses: 0, wins: 0, games: 0 };
  if (!known) {
    youBox.textContent = "La progression n’est pas disponible.";
  } else {
    const level = levelOf(Number(player.xp) || 0);
    const floor = level.xp;
    const width = level.next ? Math.max(4, Math.min(100, Math.round((((Number(player.xp) || 0) - floor) / (level.next.xp - floor)) * 100))) : 100;
    const next = level.next
      ? `${Number(player.xp) || 0} / ${level.next.xp} XP`
      : `${Number(player.xp) || 0} XP · niveau le plus haut`;
    youBox.className = "rank-you";
    youBox.innerHTML = `<div class="rank-line"><span class="rank-mark ${level.icon}">${iconMarkup(level.icon)}</span><div><h3>${esc(level.name)}</h3><p class="rank-xp">${esc(player.name)} · record ${Number(player.best) || 0}</p></div></div>
      <div class="xp-track" aria-hidden="true"><i style="width:${width}%"></i></div>
      <p class="rank-xp">${next}</p>`;
  }
  const earned = new Set(known ? earnedBadges(player) : []);
  const xp = Number(player.xp) || 0;
  const current = known ? levelOf(xp) : null;
  const levels = LEVELS.map((item) => {
    const here = current && item.name === current.name;
    const label = !known ? `${item.xp} XP` : here ? (current.next ? "En cours" : "Atteint") : xp >= item.xp ? "Atteint" : `${item.xp} XP`;
    return `<li class="${here ? "current" : known && xp >= item.xp ? "reached" : ""}"><strong>${esc(item.name)}</strong><span>${label}</span></li>`;
  }).join("");
  const badges = BADGE_GOALS.map((item) => `<li class="${earned.has(item.name) ? "reached" : ""}"><img src="${item.img}" alt=""><strong>${esc(item.name)}</strong><span>${earned.has(item.name) ? "Atteint" : esc(item.need)}</span></li>`).join("");
  $("level-list").innerHTML = `<h2>Niveaux</h2><ul class="goal-list level-scroll">${levels}</ul><h2>Badges à atteindre</h2><ul class="goal-list">${badges}</ul>`;
}

let rankBoard = "general";
const rankBoards = { general: null, online: null };

function renderBoard(rows) {
  rankBoards[rankBoard] = Array.isArray(rows) ? rows : null;
  paintBoard();
}

function paintBoard() {
  const top = $("rank-top");
  const list = $("rank-list");
  const count = $("rank-count");
  const query = foldName($("rank-search")?.value || "");
  const rankCache = rankBoards[rankBoard];
  top.replaceChildren();
  list.replaceChildren();
  if (!rankCache) {
    count.textContent = "Le classement n’est pas disponible.";
    return;
  }
  const people = Number(rankCache[0]?.people) || 0;
  const rows = query ? rankCache.filter((row) => foldName(row.name).includes(query)) : rankCache;
  count.textContent = query
    ? `${rows.length} trouvé${rows.length > 1 ? "s" : ""}`
    : `${people} personne${people > 1 ? "s" : ""}`;
  const podium = query ? [] : rows.filter((item) => Number(item.rank) <= 3);
  const rest = query ? rows : rows.filter((item) => Number(item.rank) > 3);
  for (const row of podium) {
    const card = document.createElement("article");
    const rank = Number(row.rank);
    card.className = `podium-card rank-${rank}${row.you ? " you" : ""}`;
    if (row.id) card.dataset.player = row.id;
    card.innerHTML = `<img class="podium-medal" src="img/medaille-${rank}.png" alt=""><span class="face">${faceMarkup(row.photo, true)}</span>${row.you ? `<em class="you-tag">Toi</em>` : ""}${rankNameButton(row)}<p class="podium-xp">${Number(row.xp) || 0} XP</p>`;
    top.append(card);
  }
  bindFaceImages(top);
  if (query && !rows.length) {
    const empty = document.createElement("li");
    empty.className = "rank-row";
    empty.textContent = "Aucun nom.";
    list.append(empty);
  }
  for (const row of rest) {
    const item = document.createElement("li");
    item.className = row.you ? "rank-row you" : "rank-row";
    if (row.id) item.dataset.player = row.id;
    item.innerHTML = `<span class="rank-num">${Number(row.rank)}</span><span class="face">${faceMarkup(row.photo, true)}</span>${rankNameButton(row)}${row.you ? `<em class="you-tag">Toi</em>` : ""}<span class="rank-points">${Number(row.xp) || 0} XP</span>`;
    list.append(item);
  }
  bindFaceImages(list);
}

function rankNameButton(row) {
  return `<button type="button" class="rank-name" data-player="${esc(row.id || "")}">${esc(row.name)}</button>`;
}

function boardPlace(row) {
  if (!row) return "Pas dans ce classement.";
  const place = Number(row.rank);
  return `${place}${place === 1 ? "er" : "e"} sur ${row.people} · ${Number(row.xp) || 0} XP`;
}

async function showPlayerCard(id) {
  const dialog = $("rank-card");
  const body = $("rank-card-body");
  if (!dialog || !body || !id) return;
  body.innerHTML = `<p>Chargement…</p>`;
  dialog.hidden = false;
  const card = await sendJson(`/api/player-card?id=${encodeURIComponent(id)}&player=${encodeURIComponent(playerId())}`, "GET");
  if (dialog.hidden) return;
  if (!card?.name) {
    dialog.hidden = true;
    toast("La fiche n’a pas pu se charger.");
    return;
  }
  const self = id === playerId();
  const onlineOnly = rankBoard === "online";
  const block = onlineOnly ? card.stats?.online : card.stats?.general;
  const played = Number(block?.played ?? (onlineOnly ? card.online?.games : card.games)) || 0;
  const wins = Number(block?.wins ?? (onlineOnly ? card.online?.wins : card.wins)) || 0;
  const losses = Number(block?.losses) || 0;
  const draws = Number(block?.draws) || 0;
  const place = onlineOnly ? boardPlace(card.online) : boardPlace(card.general);
  body.innerHTML = `<div class="rank-card-top"><span class="face">${faceMarkup(card.photo, true)}</span><strong>${esc(card.name)}</strong></div>
    <p><span>Profil</span> Enregistré.</p>
    <p><span>${onlineOnly ? "Parties en ligne" : "Parties jouées"}</span> ${played}</p>
    ${self || onlineOnly ? "" : `<p><span>Parties avec toi</span> ${Number(card.together) || 0}</p>`}
    <p><span>${onlineOnly ? "Classement en ligne" : "Classement général"}</span> ${esc(place)}</p>
    ${onlineOnly ? "" : `<p><span>En ligne</span> ${esc(boardPlace(card.online))}</p>`}
    <p><span>Maisons</span> ${Number(onlineOnly ? card.online?.houses : card.houses) || 0} · record ${Number(onlineOnly ? card.online?.best : card.best) || 0}</p>
    <p><span>Victoires</span> ${wins}</p>
    <p><span>Défaites</span> ${losses}</p>
    <p><span>Égalités</span> ${draws}</p>
    ${onlineOnly ? "" : `<p><span>Expert battu</span> ${Number(card.expertWins) || 0}</p>`}`;
  bindFaceImages(body);
}

function scrollToMyRank() {
  const mine = document.querySelector("#rank-top .you, #rank-list .you");
  if (!mine) {
    toast("Ton profil n’est pas dans ce classement.");
    return;
  }
  const list = $("rank-list");
  if (list.contains(mine)) {
    const listRect = list.getBoundingClientRect();
    const mineRect = mine.getBoundingClientRect();
    list.scrollTop += mineRect.top - listRect.top - (list.clientHeight - mineRect.height) / 2;
  }
  mine.scrollIntoView({ block: "center", behavior: "smooth" });
}
function renderBadgeCatalog() {
  $("badge-list").innerHTML = BADGE_GOALS.map((item) => `<p><img src="${item.img}" alt="">${esc(item.name)}</p>`).join("");
}

function selectRank(board) {
  rankBoard = board === "online" ? "online" : "general";
  $("rank-general").setAttribute("aria-pressed", rankBoard === "general" ? "true" : "false");
  $("rank-online").setAttribute("aria-pressed", rankBoard === "online" ? "true" : "false");
  if (rankBoards[rankBoard]) paintBoard();
  else loadRanking();
}

async function loadRanking() {
  const board = rankBoard;
  const count = $("rank-count");
  if (count && !rankBoards[board]) count.textContent = "Chargement du classement…";
  try {
    const rows = await sendJson(`/api/ranking?player=${encodeURIComponent(playerId())}&board=${board}`, "GET");
    const list = Array.isArray(rows) ? rows : null;
    if (list) rankBoards[board] = list;
    if (board !== rankBoard || $("screen-rank").hidden) return;
    renderBoard(list);
    if (!list && count) count.textContent = "Le classement n’a pas pu se charger.";
  } catch {
    if (board === rankBoard && !$("screen-rank").hidden && count) count.textContent = "Le classement n’a pas pu se charger.";
  }
}

function progressFromHistory(games) {
  const perHouse = { easy: 7, medium: 8, hard: 9, veryhard: 10, expert: 10 };
  const stats = { xp: 0, houses: 0, best: 0, games: 0, wins: 0, expertWins: 0 };
  for (const game of games || []) {
    if (game.mode !== "solo" || Number(game.userSeat) !== 0) continue;
    const houses = Number(Array.isArray(game.scores) ? game.scores[0] : game.scores?.[0]);
    if (!Number.isFinite(houses)) continue;
    const per = perHouse[game.difficulty] || 8;
    const win = String(game.winner) === "0" ? 15 : 0;
    stats.xp += 15 + houses * per + win;
    stats.houses += houses;
    stats.best = Math.max(stats.best, houses);
    stats.games += 1;
    if (win) stats.wins += 1;
    if (win && game.difficulty === "expert") stats.expertWins += 1;
  }
  for (const game of games || []) {
    if (game.mode !== "online") continue;
    const seat = Number(game.userSeat);
    if (seat !== 0 && seat !== 1) continue;
    const houses = Number(Array.isArray(game.scores) ? game.scores[seat] : game.scores?.[seat]);
    if (!Number.isFinite(houses)) continue;
    const win = String(game.winner) === String(seat) ? 15 : 0;
    stats.xp += 15 + houses * 9 + win;
    stats.houses += houses;
    stats.best = Math.max(stats.best, houses);
    stats.games += 1;
    if (win) stats.wins += 1;
  }
  stats.xp += challengeBonus(games);
  return stats;
}

function loadProgress() {
  const local = progressFromHistory(loadHistory());
  renderProgress([{ ...local, you: true, name: loadProfile().name || "Toi" }]);
  sendJson(`/api/progress?player=${encodeURIComponent(playerId())}`, "GET").then((row) => {
    if (!$("screen-progress").hidden && row && typeof row.xp === "number") {
      renderProgress([{
        ...local,
        xp: row.xp,
        houses: row.houses,
        best: row.best,
        games: row.games,
        wins: row.wins,
        expertWins: row.expertWins,
        you: true,
        name: row.name || loadProfile().name || "Toi",
      }]);
    }
  }).catch(() => {});
}

function openProfile() {
  show("screen-profile");
}

function openProgress() {
  show("screen-progress");
}

function openBadges() {
  show("screen-badges");
}

function remember(settings) {
  const { p1Name, p2Name, ...rest } = settings;
  app.prefs = { ...app.prefs, ...rest, scoreChosen: true };
  savePrefs(app.prefs);
  app.sounds.enabled = false;
}

function startMatch(settings, mode) {
  remember(settings);
  app.ignoreOnline = true;
  app.mode = mode;
  app.paused = false;
  app.inputLock = false;
  app.timeoutQueued = null;
  app.recorded = false;
  app.clockSync = null;
  app.roomCode = null;
  app.starterFlip = 0;
  app.game = createGame(settings, 0);
  app.game.settings.difficulty = settings.difficulty;
  app.seat = 0;
  app.players = [
    { name: settings.p1Name, color: settings.p1Color, kind: "human" },
    {
      name: mode === "solo" ? `Robot · ${DIFF_LABEL[settings.difficulty]}` : settings.p2Name,
      color: settings.p2Color,
      kind: mode === "solo" ? "ai" : "human",
    },
  ];
  app.board.clearAnims();
  resetSheetZoom();
  app.startedAt = Date.now();
  app.challengeId = null;
  app.challengeMs = 0;
  app.challengeVerdict = null;
  app.robotSpeak = {};
  app.wasBehind = false;
  app.handCloses = 0;
  app.traceFaults = 0;
  app.freshChallenges = [];
  show("screen-game");
  paintMatch();
  showModeReminder();
  if (mode === "solo" && app.game.current === 1) queueAi();
  saveMatch();
  announcePresence();
}

function showModeReminder() {
  app.tracing = false;
  app.board?.setTracing(false);
  const hand = app.game?.settings?.closeMode === "hand";
  const key = hand ? "hand" : "auto";
  try {
    if (sessionStorage.getItem("egmon-close-hint") === key) return;
    sessionStorage.setItem("egmon-close-hint", key);
  } catch { /* ignore */ }
  showOverlay({
    kicker: hand ? "Dessiner seul" : "Le système",
    title: hand ? "Tu dessines" : "Le système ferme",
    text: hand
      ? "Quand une maison est prête, glisse sur tes points pour la fermer."
      : "Les maisons se ferment toutes seules.",
    actions: [{ label: "Compris", primary: true, on: hideOverlay }],
  });
  $("game-overlay").dataset.dismiss = "1";
}

const sheetZoom = { value: 1 };

function sheetZoomBounds(stage) {
  const wrap = document.querySelector(".board-wrap");
  const cols = Number(wrap?.style.getPropertyValue("--sheet-w")) || app.game?.cols || 24;
  const rows = Number(wrap?.style.getPropertyValue("--sheet-h")) || app.game?.rows || 32;
  const pad = 44;
  const fitW = Math.max(1, stage.clientWidth - pad) / (cols * 72);
  const fitH = Math.max(1, stage.clientHeight - pad) / (rows * 72);
  const min = Math.min(1, fitW, fitH);
  return { min: Math.max(0.18, min), max: 1.8 };
}

function applySheetZoom(next, anchorX, anchorY) {
  const stage = document.querySelector(".board-stage");
  const wrap = document.querySelector(".board-wrap");
  if (!stage || !wrap || stage.clientWidth < 20) return;
  const bounds = sheetZoomBounds(stage);
  const zoom = Math.min(bounds.max, Math.max(bounds.min, next));
  if (Math.abs(zoom - sheetZoom.value) < 0.004) return;
  const before = wrap.getBoundingClientRect();
  const relX = anchorX - before.left;
  const relY = anchorY - before.top;
  sheetZoom.value = zoom;
  wrap.style.setProperty("--sheet-zoom", zoom.toFixed(4));
  const after = wrap.getBoundingClientRect();
  const scale = before.width ? after.width / before.width : 1;
  stage.scrollLeft += relX * (scale - 1);
  stage.scrollTop += relY * (scale - 1);
  app.board?.resize();
}

let pendingSheetFit = false;

function fitSheet() {
  if (!pendingSheetFit) return;
  const stage = document.querySelector(".board-stage");
  const wrap = document.querySelector(".board-wrap");
  if (!stage || !wrap || stage.clientWidth < 20) return;
  const zoom = sheetZoomBounds(stage).min;
  sheetZoom.value = zoom;
  wrap.style.setProperty("--sheet-zoom", zoom.toFixed(4));
  stage.scrollLeft = 0;
  stage.scrollTop = 0;
  pendingSheetFit = false;
  app.board?.resize();
}

function resetSheetZoom() {
  pendingSheetFit = true;
  const wrap = document.querySelector(".board-wrap");
  sheetZoom.value = 0.35;
  wrap?.style.setProperty("--sheet-zoom", "0.35");
  fitSheet();
  requestAnimationFrame(() => requestAnimationFrame(fitSheet));
}

function bindSheetZoom() {
  const stage = document.querySelector(".board-stage");
  if (!stage) return;
  const points = new Map();
  let pinch = null;
  const dropPinch = () => {
    if (points.size >= 2) return;
    pinch = null;
  };
  stage.addEventListener("pointerdown", (event) => {
    points.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (points.size < 2) return;
    const [a, b] = [...points.values()];
    pinch = {
      dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
      zoom: sheetZoom.value,
    };
    if (!app.board) return;
    app.board.press = null;
    app.board.trace = [];
    app.board.traceFault = false;
    app.board.traceId = null;
  });
  stage.addEventListener("pointermove", (event) => {
    if (!points.has(event.pointerId)) return;
    points.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (!pinch || points.size < 2) return;
    event.preventDefault();
    const [a, b] = [...points.values()];
    const dist = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
    applySheetZoom(pinch.zoom * (dist / pinch.dist), (a.x + b.x) / 2, (a.y + b.y) / 2);
  }, { passive: false });
  stage.addEventListener("pointerup", (event) => {
    points.delete(event.pointerId);
    dropPinch();
  });
  stage.addEventListener("pointercancel", (event) => {
    points.delete(event.pointerId);
    dropPinch();
  });
  stage.addEventListener("wheel", (event) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    const factor = event.deltaY > 0 ? 0.9 : 1.1;
    applySheetZoom(sheetZoom.value * factor, event.clientX, event.clientY);
  }, { passive: false });
  $("sheet-zoom-out").addEventListener("click", () => {
    const rect = stage.getBoundingClientRect();
    applySheetZoom(sheetZoom.value / 1.25, rect.left + rect.width / 2, rect.top + rect.height / 2);
  });
  $("sheet-zoom-in").addEventListener("click", () => {
    const rect = stage.getBoundingClientRect();
    applySheetZoom(sheetZoom.value * 1.25, rect.left + rect.width / 2, rect.top + rect.height / 2);
  });
}

function revealMove(move) {
  const stage = document.querySelector(".board-stage");
  const board = app.board;
  if (!stage || !board?.geom || !move) return;
  const [x, y] = board.point(move.c, move.r);
  const canvasRect = board.canvas.getBoundingClientRect();
  const stageRect = stage.getBoundingClientRect();
  const dotX = canvasRect.left + x - stageRect.left + stage.scrollLeft;
  const dotY = canvasRect.top + y - stageRect.top + stage.scrollTop;
  const margin = 56;
  let nextTop = stage.scrollTop;
  let nextLeft = stage.scrollLeft;
  if (dotY < nextTop + margin) nextTop = dotY - margin;
  else if (dotY > nextTop + stage.clientHeight - margin) nextTop = dotY - stage.clientHeight + margin;
  if (dotX < nextLeft + margin) nextLeft = dotX - margin;
  else if (dotX > nextLeft + stage.clientWidth - margin) nextLeft = dotX - stage.clientWidth + margin;
  if (nextTop === stage.scrollTop && nextLeft === stage.scrollLeft) return;
  stage.scrollTo({ top: Math.max(0, nextTop), left: Math.max(0, nextLeft), behavior: "smooth" });
}

function askDialog({ kicker, title, text, confirm, cancel, field, note, onYes }) {
  $("app-dialog-kicker").textContent = kicker || "";
  $("app-dialog-title").textContent = title;
  $("app-dialog-text").textContent = text || "";
  const input = $("app-dialog-input");
  const message = $("app-dialog-message");
  $("app-dialog-field").hidden = !field;
  $("app-dialog-note").hidden = !note;
  if (field) {
    $("app-dialog-field-label").textContent = field.label || "Votre nom de profil";
    input.value = field.value || "";
    input.placeholder = field.placeholder || "Ton nom";
  }
  if (note) {
    message.value = note.value || "";
    message.placeholder = note.placeholder || "Une amélioration ou un bug";
  }
  const box = $("app-dialog-actions");
  box.replaceChildren();
  const yes = document.createElement("button");
  yes.type = "button";
  yes.className = "btn primary";
  yes.textContent = confirm || "Continuer";
  const closeYes = () => {
    const name = field ? input.value.trim() : "";
    const body = note ? message.value.trim() : "";
    if (field && !name) {
      toast(field.empty || "Écris ton nom de profil.");
      input.focus();
      return;
    }
    if (note && !body) {
      toast("Écris ton message.");
      message.focus();
      return;
    }
    $("app-dialog").hidden = true;
    if (note) onYes?.({ name, message: body });
    else if (field) onYes?.(name);
    else onYes?.();
  };
  yes.addEventListener("click", closeYes);
  box.append(yes);
  if (cancel) {
    const no = document.createElement("button");
    no.type = "button";
    no.className = "btn";
    no.textContent = cancel;
    no.addEventListener("click", () => { $("app-dialog").hidden = true; });
    box.append(no);
  }
  input.onkeydown = field && !note
    ? (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        closeYes();
      }
    }
    : null;
  $("app-dialog").hidden = false;
  if (field) input.focus();
}

function wantsTrace() {
  const game = app.game;
  if (!game || game.status !== "playing" || app.paused) return false;
  if (game.settings.closeMode !== "hand") return false;
  if (app.players[game.current]?.kind === "ai") return false;
  if ($("game-overlay") && !$("game-overlay").hidden) return false;
  return canCatch(game, game.current);
}

function syncTrace() {
  const on = wantsTrace();
  if (app.tracing === on) return;
  app.tracing = on;
  app.board?.setTracing(on);
}

function paintMatch() {
  app.board.setMatch({
    game: app.game,
    colors: app.players.map((player) => COLORS[player.color]),
    penStyle: app.prefs.penStyle,
    theme: app.prefs.theme,
  });
  refreshHud();
}

function refreshHud() {
  const game = app.game;
  if (app.mode === "solo" && game && game.scores[1] > game.scores[0]) app.wasBehind = true;
  app.players.forEach((player, index) => {
    const card = $(`p${index}-card`);
    card.style.setProperty("--pen", displayColor(player.color, app.prefs.theme));
    $(`p${index}-name`).textContent = player.name;
    const profile = loadProfile();
    const showPhoto = player.kind !== "ai" && (app.mode === "online" ? index === app.seat : app.mode === "local" ? player.name === profile.name : index === 0);
    $(`p${index}-face`).innerHTML = faceMarkup(showPhoto ? profile.photo : "");
    $(`p${index}-score`).textContent = String(game?.scores[index] ?? 0);
    $(`p${index}-pen`).textContent = COLOR_LABEL[player.color] || "";
    const active = game?.status === "playing" && game.current === index;
    card.classList.toggle("active", Boolean(active));
    $(`p${index}-turn`).hidden = !active;
  });
  syncTrace();
  if (!game) return;
  $("move-count").textContent = `${game.movesPlayed} / ${game.totalDots} points`;
  const chip = $("rule-chip");
  const humanTurn = app.players[game.current]?.kind !== "ai";
  const attach = game.status === "playing" && game.settings.closeMode === "hand" && humanTurn && canCatch(game, game.current);
  if (attach) {
    chip.textContent = "Glisse sur tes points autour des enfants.";
    chip.classList.add("attach");
  } else {
    chip.textContent = matchRuleText(game);
    chip.classList.remove("attach");
  }
  $("pause-btn").hidden = app.mode === "online";
  paintChatMate();
  const chatBtn = $("chat-open");
  if (chatBtn) chatBtn.hidden = false;
  const name = app.players[game.current]?.name || "";
  const mine = app.mode !== "local" && game.current === (app.mode === "online" ? app.seat : 0);
  $("turn-label").textContent = game.status !== "playing"
    ? "Partie terminée"
    : mine
      ? "À vous de jouer"
      : `Au tour de ${name}`;
  updateTimers();
}

function matchRuleText(game) {
  const parts = ["1 point par maison"];
  if (Number(game.settings.scoreLimit) > 0) parts.push(`Premier à ${game.settings.scoreLimit}`);
  if (game.settings.timeMode === "global") {
    const minutes = Math.max(1, Math.round(Number(game.settings.timeLimit) / 60));
    parts.push(`${minutes} min`);
  }
  return parts.join(" · ");
}

function showReaction(emoji, seat) {
  if (!REACTIONS.includes(emoji)) return;
  const layer = $("reaction-stage");
  const view = document.querySelector(".board-stage");
  const sheet = document.querySelector(".board-wrap");
  if (!layer || !view || !sheet) return;
  const side = seat === 1 ? 1 : 0;
  layer.querySelector(`[data-side="${side}"]`)?.remove();
  const viewBox = view.getBoundingClientRect();
  const sheetBox = sheet.getBoundingClientRect();
  const layerBox = layer.getBoundingClientRect();
  const left = Math.max(viewBox.left, sheetBox.left);
  const right = Math.min(viewBox.right, sheetBox.right);
  const top = Math.max(viewBox.top, sheetBox.top);
  const bottom = Math.min(viewBox.bottom, sheetBox.bottom);
  const width = right - left;
  const height = bottom - top;
  if (width < 24 || height < 24) return;
  const size = Math.max(26, Math.min(42, height * 0.16));
  const inset = Math.min(14, Math.max(6, width * 0.06));
  const rawX = side === 0 ? left + inset : right - size - inset;
  const x = Math.max(left + 4, Math.min(rawX, right - size - 4));
  const y = Math.max(top + 4, Math.min(top + height * 0.22, bottom - size - 4));
  const node = document.createElement("span");
  node.className = "sheet-react";
  node.dataset.side = String(side);
  node.textContent = emoji;
  node.style.fontSize = `${size}px`;
  node.style.left = `${x - layerBox.left}px`;
  node.style.top = `${y - layerBox.top}px`;
  layer.appendChild(node);
  node.addEventListener("animationend", () => node.remove());
}

function sendReaction(emoji, button) {
  if (!REACTIONS.includes(emoji) || !app.game || app.game.status !== "playing") return;
  const now = Date.now();
  if (now - (app.lastReactAt || 0) < 350) return;
  app.lastReactAt = now;
  if (button) {
    button.classList.remove("pop");
    void button.offsetWidth;
    button.classList.add("pop");
  }
  const seat = app.mode === "online" ? app.seat : app.mode === "local" && app.game.current === 1 ? 1 : 0;
  showReaction(emoji, seat);
  if (app.mode === "online" && app.socket?.connected && app.roomCode) {
    app.socket.emit("react", emoji);
  }
}

function foeWouldClose(game, move) {
  const saved = game.current;
  game.current = 1 - saved;
  try {
    return moveInfo(game, move).completes > 0;
  } finally {
    game.current = saved;
  }
}

function pickReaction(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function robotMaySpeak(kind) {
  if (kind === "capture") return true;
  const now = Date.now();
  if (!app.robotSpeak) app.robotSpeak = {};
  const last = app.robotSpeak.block || 0;
  if (now - last < 8000 || Math.random() > 0.4) return false;
  app.robotSpeak.block = now;
  return true;
}

function reactToMove(result, blocked) {
  if (app.mode !== "solo" || !result?.ok) return;
  const robot = app.players.findIndex((player) => player.kind === "ai");
  if (robot < 0) return;
  const human = 1 - robot;
  const took = result.completed > 0 || result.eaten > 0;
  let robotBefore = app.game.scores[robot];
  let humanBefore = app.game.scores[human];
  if (result.eaten > 0) humanBefore += result.eaten;
  if (result.player === robot) robotBefore -= result.completed > 0 ? result.completed : result.eaten;
  const cameBack = robotBefore < humanBefore && app.game.scores[robot] >= app.game.scores[human];
  let emoji = "";
  let kind = "capture";
  if (took && result.player === human) {
    emoji = Math.random() < 0.25 ? "❌" : "😭";
  } else if (took && result.player === robot) {
    const icons = ["🤣", "😂", "✅"];
    if (cameBack) icons.push("😎", "😏");
    emoji = pickReaction(icons);
  } else if (blocked && result.player === robot) {
    emoji = pickReaction(["😏", "😎"]);
    kind = "block";
  }
  if (!emoji || !robotMaySpeak(kind)) return;
  showReaction(emoji, robot);
}

function remaining(kind) {
  const game = app.game;
  if (!game) return 0;
  if (app.mode === "online" && app.clockSync) {
    return Math.max(0, (app.clockSync[kind] ?? 0) - (performance.now() - app.clockSync.at));
  }
  return kind === "global" ? game.globalRemaining ?? 0 : game.turnRemaining ?? 0;
}

function updateTimers() {
  const game = app.game;
  if (!game) return;
  const global = game.settings.timeMode === "global";
  const turn = game.settings.timeMode === "turn";
  $("clock").hidden = !global;
  $("clock").classList.toggle("low", global && remaining("global") <= 30_000 && game.status === "playing");
  if (global) $("clock").textContent = formatClock(remaining("global"));
  const turnMs = turn ? remaining("turn") : 0;
  const ratio = turn && game.turnLimit ? Math.max(0, Math.min(1, turnMs / game.turnLimit)) : 0;
  [0, 1].forEach((index) => {
    const showBar = turn && game.current === index && game.status === "playing";
    $(`p${index}-bar`).hidden = !showBar;
    $(`p${index}-time`).hidden = !showBar;
    if (showBar) {
      $(`p${index}-bar`).firstElementChild.style.transform = `scaleX(${ratio})`;
      $(`p${index}-time`).textContent = formatClock(turnMs);
    }
  });
  if (app.challengeId === "speed") {
    const left = Math.max(0, 8 * 60 * 1000 - (app.challengeMs || 0));
    $("clock").hidden = false;
    $("clock").classList.toggle("low", left <= 30_000 && game.status === "playing");
    $("clock").textContent = formatClock(left);
  }
  const live = $("challenge-live");
  if (live) {
    const text = challengeLiveText();
    live.hidden = !text;
    if (text) live.textContent = text;
  }
  paintDisconnectBanner();
}

function paintDisconnectBanner() {
  const banner = $("conn-banner");
  if (!banner || $("screen-game").hidden || app.mode !== "online") return;
  const own = app.selfBackAt && !app.socket?.connected ? app.selfBackAt : 0;
  const foe = app.foeBackAt || 0;
  const deadline = own || foe;
  if (!deadline) return;
  const left = Math.max(0, deadline - Date.now());
  const clock = formatClock(left);
  const text = own
    ? (left > 0 ? `Connexion coupée. Reviens dans ${clock}.` : "Connexion coupée. La partie est perdue.")
    : (left > 0
      ? `${app.players[1 - app.seat]?.name || "L’adversaire"} est déconnecté. Abandon dans ${clock}.`
      : `${app.players[1 - app.seat]?.name || "L’adversaire"} est déconnecté. Abandon…`);
  banner.hidden = false;
  if (banner.textContent !== text) banner.textContent = text;
}

function hideOverlay() {
  const overlay = $("game-overlay");
  overlay.hidden = true;
  overlay.classList.remove("celebrate");
  delete overlay.dataset.dismiss;
}

function openFeedback() {
  const profile = loadProfile();
  askDialog({
    kicker: "Message",
    title: "Écrire un message",
    text: "Une amélioration, ou un bug à signaler.",
    confirm: "Envoyer",
    cancel: "Retour",
    field: {
      label: "Ton nom",
      value: profile.name || "",
      placeholder: "Ton nom",
      empty: "Écris ton nom.",
    },
    note: { placeholder: "Décris l'idée ou le problème" },
    onYes: async ({ name, message }) => {
      const saved = await sendJson("/api/messages", "POST", { name, message });
      toast(saved?.ok ? "Message envoyé. Merci." : "Le message n'a pas pu partir.");
    },
  });
}

function showOverlay({ kicker, title, text, actions, note = false, celebrate = false }) {
  delete $("game-overlay").dataset.dismiss;
  $("overlay-kicker").textContent = kicker || "";
  $("overlay-title").textContent = title;
  $("overlay-text").textContent = text || "";
  const box = $("overlay-actions");
  box.replaceChildren();
  for (const action of actions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = action.primary ? "btn primary" : "btn";
    button.textContent = action.label;
    if (action.disabled) button.disabled = true;
    else button.addEventListener("click", action.on);
    box.appendChild(button);
  }
  const extra = $("overlay-note");
  extra.replaceChildren();
  extra.hidden = !note;
  if (note) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Une amélioration ou un bug ? Écris un message.";
    button.addEventListener("click", openFeedback);
    extra.append(button);
  }
  const overlay = $("game-overlay");
  overlay.classList.toggle("celebrate", celebrate);
  overlay.hidden = false;
}

function canPlay() {
  if (app.tracing) return false;
  if ($("game-overlay") && !$("game-overlay").hidden) return false;
  if ($("chat-panel") && !$("chat-panel").hidden) return false;
  if ($("app-dialog") && !$("app-dialog").hidden) return false;
  if ($("rank-card") && !$("rank-card").hidden) return false;
  if (!app.game || app.game.status !== "playing" || app.paused || app.inputLock) return false;
  if (app.game.settings.timeMode === "global" && remaining("global") <= 0) return false;
  if (app.mode === "online") return app.seat === app.game.current;
  if (app.mode === "solo") return app.players[app.game.current]?.kind === "human";
  return true;
}

function tryMove(move) {
  if (!canPlay()) return;
  if (app.mode === "online") {
    app.inputLock = true;
    clearTimeout(app.moveWatch);
    app.moveWatch = setTimeout(() => {
      app.moveWatch = null;
      if (app.inputLock && app.mode === "online") {
        app.inputLock = false;
        toast("Le coup n’est pas parti. Réessaie.");
      }
    }, 5000);
    app.socket.emit("move", move, (res) => {
      if (!res?.ok) {
        clearTimeout(app.moveWatch);
        app.inputLock = false;
        if (res?.error) toast(res.error);
      }
    });
    return;
  }
  playLocal(move, false);
}

function playLocal(move, fromTimeout) {
  const blocked = app.players[app.game.current]?.kind === "ai" && foeWouldClose(app.game, move);
  const human = app.players[app.game.current]?.kind !== "ai";
  const manual = human && app.game.settings.closeMode === "hand";
  const result = applyMove(app.game, move, { autoClose: !manual });
  if (!result.ok) return;
  app.inputLock = true;
  app.board.animate(move, result);
  if (fromTimeout) toast("Temps écoulé : un point a été posé.");
  app.sounds.line();
  if (result.completed) {
    app.sounds.box();
    popScore(result.player);
  }
  if (result.eaten) popScore(1 - result.player);
  reactToMove(result, blocked);
  refreshHud();
  saveMatch();
  revealMove(move);
  window.setTimeout(() => afterMove(), 230 + result.completed * 180);
}

function popScore(player) {
  const el = $(`p${player}-score`);
  el.classList.remove("pop");
  void el.offsetWidth;
  el.classList.add("pop");
}

function afterMove() {
  saveMatch();
  app.inputLock = false;
  if (!app.game) return;
  if (app.game.status === "finished") {
    endLocal();
    return;
  }
  const queued = app.timeoutQueued;
  if (queued != null && app.game.turnRemaining === 0 && app.game.current === queued) {
    onTurnTimeout();
    return;
  }
  app.timeoutQueued = null;
  if (app.mode === "solo" && app.players[app.game.current]?.kind === "ai" && !app.paused) queueAi();
}

function robotBehind() {
  const game = app.game;
  if (!game || game.status !== "playing") return false;
  const level = ROBOT_GAP[game.settings?.difficulty] ? game.settings.difficulty : "medium";
  const openSheet = !(Number(game.settings?.scoreLimit) > 0);
  const need = ROBOT_GAP[level][openSheet ? 1 : 0];
  return game.scores[0] - game.scores[1] >= need;
}

function queueAi() {
  app.inputLock = true;
  window.setTimeout(() => {
    const stillAi = !app.paused
      && app.mode === "solo"
      && app.game?.status === "playing"
      && app.players[app.game.current]?.kind === "ai";
    if (!stillAi) {
      app.inputLock = false;
      return;
    }
    if (app.timeoutQueued != null && app.game.turnRemaining === 0) {
      app.inputLock = false;
      onTurnTimeout();
      return;
    }
    if (robotBehind()) {
      app.game.winner = 0;
      app.game.reason = "robot";
      app.game.status = "finished";
      endLocal();
      return;
    }
    const move = chooseMove(app.game, app.game.settings?.difficulty || app.prefs.difficulty);
    if (!move) {
      app.inputLock = false;
      return;
    }
    playLocal(move, false);
  }, 320);
}

function onTurnTimeout() {
  if (!app.game || app.game.status !== "playing") return;
  if (app.inputLock) {
    app.timeoutQueued = app.game.current;
    return;
  }
  app.timeoutQueued = null;
  const moves = legalMoves(app.game);
  if (!moves.length) return;
  playLocal(moves[Math.floor(Math.random() * moves.length)], true);
}

async function sendJson(url, method, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) return null;
  return res.json();
}

function syncProfile(profile) {
  sendJson(`/api/profile/${playerId()}`, "PUT", profile).catch(() => {});
}

async function pullProfile() {
  try {
    const profile = await sendJson(`/api/profile/${playerId()}`, "GET");
    if (!profile) return;
    const local = loadProfile();
    if (!profile.name && local.name) {
      syncProfile(local);
      return;
    }
    if (!profile.name) return;
    saveProfile(profile);
    noteAdmin(profile);
    announcePresence();
    if (!$("screen-profile").hidden && !$("photo-btn")?.classList.contains("is-busy")) fillProfileForm(loadProfile());
  } catch {
    /* le profil reste dans le navigateur */
  }
}

function syncGame(entry) {
  sendJson(`/api/games/${playerId()}`, "POST", entry).catch(() => {});
}

async function pullHistory() {
  try {
    const payload = await sendJson(`/api/games/${playerId()}`, "GET");
    const games = Array.isArray(payload) ? payload : payload?.games;
    if (!Array.isArray(games)) return false;
    gameStats = payload?.stats || null;
    if (!games.length) {
      loadHistory().forEach((entry) => syncGame(entry));
      if (!$("screen-history").hidden) renderHistory();
      return true;
    }
    replaceHistory(games);
    if (!$("screen-history").hidden) renderHistory();
    const panel = document.querySelector("[data-hub-panel=challenges]");
    if (panel && !panel.hidden) renderChallenges();
    return true;
  } catch {
    return false;
  }
}

function recordGame() {
  if (app.recorded || !app.game) return;
  app.recorded = true;
  const game = app.game;
  const userSeat = app.mode === "local" ? null : app.mode === "online" ? app.seat : 0;
  const before = earnedChallengeIds();
  const entry = {
    id: crypto.randomUUID(),
    at: Date.now(),
    mode: app.mode,
    size: `${game.rows}×${game.cols}`,
    names: app.players.map((player) => player.name),
    scores: game.scores.slice(),
    winner: game.winner,
    userSeat,
    reason: game.reason,
    difficulty: app.mode === "solo" ? (app.game.settings?.difficulty || app.prefs.difficulty) : null,
    durationMs: app.challengeId
      ? Math.max(0, Math.round(app.challengeMs || 0))
      : app.startedAt ? Math.max(0, Date.now() - app.startedAt) : 0,
    behind: app.wasBehind === true,
    clean: app.prefs.closeMode === "hand" && app.handCloses > 0 && !app.traceFaults,
  };
  pushHistory(entry);
  app.freshChallenges = CHALLENGES.filter((item) => earnedChallengeIds().has(item.id) && !before.has(item.id));
  syncGame(entry);
  if (game.winner === "draw") app.sounds.tap();
  else if (userSeat == null || game.winner === userSeat) app.sounds.win();
  else app.sounds.lose();
}

function challengeLiveText() {
  const id = app.challengeId;
  const game = app.game;
  if (!id || !game) return "";
  const mine = housesOf(game, 0);
  const foe = housesOf(game, 1);
  if (id === "speed") return `${mine} / 10 maisons`;
  if (id === "precision") {
    if (app.traceFaults) return "Erreur au tracé.";
    return `Maisons fermées à la main : ${app.handCloses || 0}`;
  }
  if (id === "dominate") return `${mine} / 10 maisons`;
  if (id === "comeback") {
    if (!app.wasBehind) return "Tu n’es pas encore mené.";
    if (foe > mine) return "Tu es mené.";
    if (mine > foe) return "Tu as repris l’avance.";
    return "Égalité après avoir été mené.";
  }
  if (id === "expert") return "Robot au niveau expert.";
  if (id === "blank") return `Maisons laissées à l’autre : ${foe}`;
  if (id === "streak") return streakLine(3);
  if (id === "week") return streakLine(7);
  return "";
}

function immediateChallengeVerdict() {
  const id = app.challengeId;
  const game = app.game;
  if (!id || !game || game.status !== "playing") return null;
  const mine = housesOf(game, 0);
  const foe = housesOf(game, 1);
  const elapsed = app.challengeMs || 0;
  if (id === "speed") {
    if (mine >= 10 && elapsed <= 8 * 60 * 1000) return "won";
    if (elapsed >= 8 * 60 * 1000) return "lost";
  }
  if (id === "precision") {
    if (app.traceFaults > 0) return "lost";
    if (app.handCloses > 0) return "won";
  }
  if (id === "dominate" && mine >= 10 && mine > foe) return "won";
  if (id === "comeback" && app.wasBehind && mine > foe) return "won";
  if (id === "blank" && foe > 0) return "lost";
  return null;
}

function finalChallengeVerdict() {
  const id = app.challengeId;
  const game = app.game;
  if (!id || !game) return null;
  const mine = housesOf(game, 0);
  const foe = housesOf(game, 1);
  const elapsed = app.challengeMs || 0;
  if (id === "speed") return mine >= 10 && elapsed <= 8 * 60 * 1000 ? "won" : "lost";
  if (id === "precision") return app.handCloses > 0 && !app.traceFaults ? "won" : "lost";
  if (id === "dominate") return wonGame(game) && mine >= 10 ? "won" : "lost";
  if (id === "comeback") return app.wasBehind === true && wonGame(game) ? "won" : "lost";
  if (id === "expert") return game.reason === "abandon" ? "lost" : "won";
  if (id === "blank") return wonGame(game) && foe === 0 && mine > 0 ? "won" : "lost";
  if (id === "streak" || id === "week") {
    const need = id === "week" ? 7 : 3;
    return streakProgress(need).remaining === 0 ? "won" : "progress";
  }
  return null;
}

function finishChallenge(verdict) {
  if (!app.game || app.game.status !== "playing") return;
  app.challengeVerdict = verdict;
  const mine = app.game.scores[0];
  const foe = app.game.scores[1];
  app.game.winner = mine === foe ? "draw" : mine > foe ? 0 : 1;
  app.game.reason = app.game.reason || (verdict === "lost" && app.challengeId === "speed" ? "time" : "score");
  app.game.status = "finished";
  endLocal();
}

function resultCopy() {
  const game = app.game;
  const scoreLine = `${app.players[0].name} ${game.scores[0]}  ·  ${game.scores[1]} ${app.players[1].name}`;
  if (app.challengeId) {
    const item = CHALLENGES.find((entry) => entry.id === app.challengeId);
    const verdict = app.challengeVerdict || finalChallengeVerdict();
    const need = app.challengeId === "week" ? 7 : app.challengeId === "streak" ? 3 : 0;
    if (verdict === "progress" && need) {
      return { kicker: "Défi", title: "Série en cours", text: `${streakLine(need)}\n${scoreLine}`, celebrate: false };
    }
    const won = verdict === "won";
    return {
      kicker: "Défi",
      title: won ? "Défi gagné" : "Défi perdu",
      text: `${item?.name || "Défi"}\n${scoreLine}`,
      celebrate: won,
    };
  }
  let title = "Égalité";
  if (game.winner === 0 || game.winner === 1) {
    if (app.mode === "local") title = `${app.players[game.winner].name} gagne`;
    else title = game.winner === (app.mode === "online" ? app.seat : 0) ? "Victoire" : "Défaite";
  }
  let because = REASON[game.reason] || "";
  if (game.reason === "board" && game.settings.scoreLimit > 0) {
    because = "La feuille est pleine avant l’objectif. Le plus grand score gagne.";
  }
  const earned = app.freshChallenges || [];
  const extra = earned.length ? `\n${earned.map((item) => `${item.name} · +${item.xp} XP`).join("\n")}` : "";
  const text = `${scoreLine}\n${because}${extra}`;
  return { title, text, celebrate: title === "Victoire" || (app.mode === "local" && title !== "Égalité") };
}

function showResult() {
  const { title, text, celebrate, kicker } = resultCopy();
  const offer = app.mode === "online" ? app.rematchOffer : "";
  let actions = [
    { label: "Accueil", on: () => goHome() },
    { label: "Revanche", primary: true, on: () => askRematch() },
  ];
  let line = text;
  if (offer === "theirs") {
    line = `${text}\nRevanche proposée.`;
    actions = [
      { label: "Accueil", on: () => goHome() },
      { label: "Refuser", on: () => declineRematch() },
      { label: "Accepter", primary: true, on: () => acceptRematch() },
    ];
  } else if (offer === "mine") {
    actions = [
      { label: "Accueil", on: () => goHome() },
      { label: "En attente…", primary: true, disabled: true },
    ];
  }
  showOverlay({
    kicker: kicker || "Partie terminée",
    title,
    text: line,
    celebrate,
    note: true,
    actions,
  });
}

function endLocal() {
  app.inputLock = true;
  recordGame();
  updateTimers();
  showResult();
  announcePresence();
}

function askRematch() {
  if (app.mode !== "online") {
    rematch();
    return;
  }
  if (!app.socket?.connected) {
    toast("La connexion a sauté.");
    return;
  }
  app.rematchOffer = "mine";
  app.socket.emit("rematch");
  showResult();
}

function acceptRematch() {
  if (!app.socket?.connected) {
    toast("La connexion a sauté.");
    return;
  }
  app.socket.emit("rematch");
}

function declineRematch() {
  app.rematchOffer = "";
  app.socket?.emit("rematch-no");
  showResult();
}

function rematch() {
  if (app.mode === "online") {
    askRematch();
    return;
  }
  hideOverlay();
  app.rematchOffer = "";
  app.starterFlip = app.starterFlip === 0 ? 1 : 0;
  app.game = createGame(app.prefs, app.starterFlip);
  app.game.settings.difficulty = app.prefs.difficulty;
  app.paused = false;
  app.inputLock = false;
  app.recorded = false;
  app.timeoutQueued = null;
  app.board.clearAnims();
  paintMatch();
  showModeReminder();
  if (app.mode === "solo" && app.game.current === 1) queueAi();
  saveMatch();
  announcePresence();
}

let chatRemind = 0;

function otherSeat() {
  if (app.mode === "online") return app.seat === 1 ? 0 : 1;
  if (app.mode === "solo") return 1;
  const mine = (loadProfile().name || "").trim();
  const index = (app.players || []).findIndex((player) => player?.name !== mine);
  return index >= 0 ? index : 1;
}

let mateKey = "";

function paintChatMate() {
  const title = $("chat-mate");
  const player = app.players?.[otherSeat()];
  if (title) title.textContent = player?.name || "Discussion";
  const key = player?.name ? `${player.kind || "human"}|${player.name}` : "";
  if (key === mateKey) return;
  mateKey = key;
  paintMate(player);
}

function setChatAlert(on) {
  const light = $("chat-light");
  const button = $("chat-open");
  if (light) light.hidden = !on;
  if (button) {
    button.classList.toggle("has-mail", on);
    button.setAttribute("aria-label", on ? "Nouveau message" : "Discussion");
  }
  if (!on) {
    clearTimeout(chatRemind);
    chatRemind = 0;
  }
}

function sheetChatNote(text) {
  const note = $("chat-note");
  if (!note) return;
  note.textContent = text;
  note.hidden = false;
  clearTimeout(sheetChatNote.timer);
  sheetChatNote.timer = setTimeout(() => { note.hidden = true; }, 1500);
}

function noteIncomingChat() {
  setChatAlert(true);
  sheetChatNote("Un nouveau message. Discuter.");
  clearTimeout(chatRemind);
  chatRemind = setTimeout(() => {
    if ($("chat-light")?.hidden) return;
    sheetChatNote("Clique sur l’icône de message.");
  }, 4500);
}

const VOICE_PLAY = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5-11-6.5z"/></svg>`;
const VOICE_PAUSE = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h4v14H7V5zm6 0h4v14h-4V5z"/></svg>`;

function voiceClock(seconds) {
  const n = Math.max(0, Math.round(Number(seconds) || 0));
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`;
}

function voiceBars(host, count) {
  host.replaceChildren();
  for (let i = 0; i < count; i += 1) {
    const bar = document.createElement("i");
    bar.style.setProperty("--n", String(i));
    host.append(bar);
  }
}

function paintVoiceBars(host, ratio) {
  const bars = [...host.children];
  const lit = Math.round(Math.min(1, Math.max(0, ratio)) * bars.length);
  bars.forEach((bar, index) => bar.classList.toggle("is-on", index < lit));
}

function mixDown(buffer, rate) {
  const length = buffer.length;
  const mono = new Float32Array(length);
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < length; i += 1) mono[i] += data[i] / buffer.numberOfChannels;
  }
  if (buffer.sampleRate === rate) return mono;
  const outLength = Math.max(1, Math.round(mono.length * rate / buffer.sampleRate));
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i += 1) {
    const pos = i * buffer.sampleRate / rate;
    const left = Math.floor(pos);
    const right = Math.min(mono.length - 1, left + 1);
    const mix = pos - left;
    out[i] = mono[left] * (1 - mix) + mono[right] * mix;
  }
  return out;
}

function encodeWav(samples, rate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const text = (offset, value) => {
    for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i));
  };
  text(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, samples.length * 2, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    offset += 2;
  }
  return new Blob([buffer], { type: "audio/wav" });
}

function readDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function wavBlob(blob, rate) {
  const ctx = new AudioContext();
  try {
    const decoded = await ctx.decodeAudioData((await blob.arrayBuffer()).slice(0));
    return encodeWav(mixDown(decoded, rate), rate);
  } finally {
    ctx.close().catch(() => {});
  }
}

async function clipFromTake(blob) {
  const asIs = voiceClip(await readDataUrl(blob));
  if (asIs && blob.size <= 900000) return { audio: asIs, blob };
  const pack = async (rate) => {
    const wav = await wavBlob(blob, rate);
    if (wav.size > 1_800_000) return null;
    const audio = voiceClip(await readDataUrl(wav));
    return audio ? { audio, blob: wav } : null;
  };
  try {
    return (await pack(8000)) || (await pack(16000));
  } catch {
    return asIs ? { audio: asIs, blob } : null;
  }
}

function voiceUrl(clip) {
  const comma = String(clip).indexOf(",");
  if (comma < 0) return clip;
  try {
    const mime = clip.slice(5, comma).split(";")[0] || "audio/webm";
    const raw = atob(clip.slice(comma + 1));
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
    return URL.createObjectURL(new Blob([bytes], { type: mime }));
  } catch {
    return clip;
  }
}

const localVoices = new Map();

function rememberVoice(id, blob) {
  if (!id || !blob) return;
  const previous = localVoices.get(id);
  if (previous) URL.revokeObjectURL(previous);
  localVoices.set(id, URL.createObjectURL(blob));
}

function voiceBubble(clip, seconds, voiceId) {
  const box = document.createElement("div");
  box.className = "chat-audio";
  const known = Math.max(0, Math.min(600, Math.round(Number(seconds) || 0)));
  const sound = document.createElement("audio");
  sound.preload = "auto";
  sound.setAttribute("playsinline", "");
  sound.src = (voiceId && localVoices.get(voiceId)) || voiceUrl(clip);
  sound.volume = 1;
  sound.style.cssText = "position:absolute;width:0;height:0;opacity:0;pointer-events:none";
  const play = document.createElement("button");
  play.type = "button";
  play.className = "chat-audio-btn";
  play.setAttribute("aria-label", "Écouter");
  play.innerHTML = VOICE_PLAY;
  const bars = document.createElement("div");
  bars.className = "voice-bars";
  voiceBars(bars, 12);
  const time = document.createElement("span");
  time.className = "chat-audio-time";
  time.textContent = voiceClock(known);
  const length = () => {
    const real = sound.duration;
    if (Number.isFinite(real) && real > 0 && real < 3600) return real;
    return known;
  };
  const paint = () => {
    const dur = length();
    const at = sound.currentTime || 0;
    time.textContent = voiceClock(!sound.paused || at > 0.2 ? at : dur);
    paintVoiceBars(bars, dur ? Math.min(1, at / dur) : 0);
  };
  const showPlay = () => {
    play.innerHTML = VOICE_PLAY;
    play.setAttribute("aria-label", "Écouter");
  };
  sound.addEventListener("loadedmetadata", paint);
  sound.addEventListener("durationchange", paint);
  sound.addEventListener("timeupdate", paint);
  sound.addEventListener("ended", () => {
    sound.currentTime = 0;
    showPlay();
    paint();
  });
  play.addEventListener("click", () => {
    if (sound.paused) {
      document.querySelectorAll(".chat-audio audio").forEach((node) => {
        if (node !== sound) node.pause();
      });
      const local = voiceId && localVoices.get(voiceId);
      if (local && sound.src !== local) sound.src = local;
      sound.play().then(() => {
        play.innerHTML = VOICE_PAUSE;
        play.setAttribute("aria-label", "Pause");
      }).catch(() => toast("Le vocal ne peut pas être lu."));
      return;
    }
    sound.pause();
    showPlay();
  });
  bars.addEventListener("click", (event) => {
    const dur = length();
    if (!Number.isFinite(dur) || dur <= 0) return;
    const rect = bars.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / Math.max(1, rect.width)));
    sound.currentTime = ratio * dur;
    paint();
  });
  box.append(sound, play, bars, time);
  return box;
}

function voiceClip(value) {
  const audio = String(value || "").replace(/\s/g, "");
  if (audio.length < 80 || audio.length > 2_500_000) return "";
  return /^data:(audio|video)\/[a-z0-9.+-]+[^,]*,[A-Za-z0-9+/=]+$/.test(audio) ? audio : "";
}

function appendChat(text, mine, audio, voiceId, seconds) {
  const body = String(text || "").trim();
  const clip = voiceClip(audio);
  const id = String(voiceId || "").replace(/[^a-zA-Z0-9-]/g, "").slice(0, 40);
  if (id && document.querySelector(`[data-voice="${id}"]`)) return;
  if (!body && !clip) return;
  const log = $("chat-log");
  const line = document.createElement("p");
  line.className = mine ? "chat-line mine" : "chat-line";
  if (id) line.dataset.voice = id;
  if (clip) line.append(voiceBubble(clip, seconds, id));
  else line.textContent = body;
  log.append(line);
  while (log.children.length > 40) log.firstChild.remove();
  log.scrollTop = log.scrollHeight;
}

let voiceRec = null;
let voiceChunks = [];
let voiceTimer = 0;
let voiceTick = 0;
let voiceMark = 0;
let voiceSkip = false;
let voiceDraft = "";
let voiceTake = null;
let voiceSeconds = 0;
let voicePreview = null;
let voicePreviewUrl = "";

function setVoiceButton(on) {
  const button = $("chat-voice");
  if (!button) return;
  button.classList.toggle("is-on", on);
  button.setAttribute("aria-pressed", on ? "true" : "false");
  button.setAttribute("aria-label", on ? "Arrêter le vocal" : "Message vocal");
}

function showVoiceStage(live) {
  const stage = $("voice-stage");
  const form = $("chat-form");
  if (!stage || !form) return;
  const bars = $("voice-bars");
  if (bars && !bars.children.length) voiceBars(bars, 12);
  stage.hidden = false;
  stage.classList.toggle("is-live", live);
  form.hidden = true;
  $("voice-done").hidden = !live;
  $("voice-hear").hidden = live;
  $("voice-send").hidden = live;
  if (live) paintVoiceBars(bars, 0);
}

function hideVoiceStage() {
  clearInterval(voiceTick);
  voiceTick = 0;
  const stage = $("voice-stage");
  const form = $("chat-form");
  if (stage) {
    stage.hidden = true;
    stage.classList.remove("is-live");
  }
  if (form) form.hidden = false;
  if (voicePreview) {
    voicePreview.pause();
    voicePreview.remove();
    voicePreview = null;
  }
  if (voicePreviewUrl) {
    URL.revokeObjectURL(voicePreviewUrl);
    voicePreviewUrl = "";
  }
  voiceTake = null;
  voiceDraft = "";
  const hear = $("voice-hear");
  if (hear) hear.innerHTML = VOICE_PLAY;
}

function startVoiceClock() {
  clearInterval(voiceTick);
  voiceMark = Date.now();
  const time = $("voice-time");
  if (time) time.textContent = "0:00";
  voiceTick = setInterval(() => {
    if (time) time.textContent = voiceClock((Date.now() - voiceMark) / 1000);
  }, 200);
}

function releaseVoice(rec) {
  rec?.stream?.getTracks().forEach((track) => track.stop());
}

function cancelVoice() {
  clearTimeout(voiceTimer);
  voiceTimer = 0;
  const rec = voiceRec;
  voiceRec = null;
  voiceChunks = [];
  setVoiceButton(false);
  hideVoiceStage();
  if (!rec) return;
  voiceSkip = true;
  if (rec.state !== "inactive") rec.stop();
  else voiceSkip = false;
  releaseVoice(rec);
}

function finishVoice(rec) {
  releaseVoice(rec);
  setVoiceButton(false);
  clearInterval(voiceTick);
  voiceTick = 0;
  const chunks = voiceChunks;
  const seconds = Math.max(1, Math.round((Date.now() - voiceMark) / 1000));
  voiceChunks = [];
  if (voiceSkip) {
    voiceSkip = false;
    return;
  }
  const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
  if (blob.size < 500) {
    hideVoiceStage();
    return;
  }
  if (blob.size > 1_200_000) {
    hideVoiceStage();
    toast("Le vocal est trop lourd.");
    return;
  }
  clipFromTake(blob).then((taken) => {
    if (!taken?.audio) {
      hideVoiceStage();
      toast("Le vocal n'a pas pu être préparé.");
      return;
    }
    voiceDraft = taken.audio;
    voiceTake = taken.blob;
    voiceSeconds = seconds;
    voicePreviewUrl = URL.createObjectURL(taken.blob);
    voicePreview = document.createElement("audio");
    voicePreview.preload = "auto";
    voicePreview.setAttribute("playsinline", "");
    voicePreview.src = voicePreviewUrl;
    voicePreview.volume = 1;
    voicePreview.style.cssText = "position:absolute;width:0;height:0;opacity:0;pointer-events:none";
    $("voice-stage")?.append(voicePreview);
    voicePreview.addEventListener("loadedmetadata", () => {
      const time = $("voice-time");
      const real = voicePreview.duration;
      if (time) time.textContent = voiceClock(Number.isFinite(real) && real > 0 && real < 3600 ? real : seconds);
    });
    voicePreview.addEventListener("ended", () => {
      const hear = $("voice-hear");
      if (hear) hear.innerHTML = VOICE_PLAY;
    });
    showVoiceStage(false);
  }).catch(() => {
    hideVoiceStage();
    toast("Le vocal n'a pas pu être préparé.");
  });
}

function hearVoiceDraft() {
  if (!voicePreview) return;
  const hear = $("voice-hear");
  if (voicePreview.paused) {
    voicePreview.play().then(() => {
      if (hear) hear.innerHTML = VOICE_PAUSE;
    }).catch(() => toast("Le vocal ne peut pas être lu."));
    return;
  }
  voicePreview.pause();
  if (hear) hear.innerHTML = VOICE_PLAY;
}

function sendVoiceDraft() {
  const audio = voiceDraft;
  if (!audio) return;
  const id = crypto.randomUUID();
  const seconds = voiceSeconds;
  if (voiceTake) rememberVoice(id, voiceTake);
  appendChat("", true, audio, id, seconds);
  if (app.mode === "online") {
    if (!app.socket?.connected || !app.roomCode) toast("La discussion n'est pas disponible.");
    else app.socket.emit("voice", { id, audio, seconds });
  }
  voiceDraft = "";
  hideVoiceStage();
}

async function toggleVoice() {
  if (voiceRec) {
    clearTimeout(voiceTimer);
    voiceTimer = 0;
    const rec = voiceRec;
    voiceRec = null;
    if (rec.state !== "inactive") rec.stop();
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
    toast("Le micro n'est pas disponible.");
    return;
  }
  if (app.mode === "online" && (!app.socket?.connected || !app.roomCode)) {
    toast("La discussion n'est pas disponible.");
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    toast("Autorise le micro pour envoyer un vocal.");
    return;
  }
  const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((type) => MediaRecorder.isTypeSupported(type)) || "";
  let rec;
  try {
    rec = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 16000 } : { audioBitsPerSecond: 16000 });
  } catch {
    releaseVoice({ stream });
    toast("Le micro n'est pas disponible.");
    return;
  }
  voiceSkip = false;
  voiceDraft = "";
  voiceChunks = [];
  voiceRec = rec;
  rec.ondataavailable = (event) => { if (event.data?.size) voiceChunks.push(event.data); };
  rec.onstop = () => finishVoice(rec);
  setVoiceButton(true);
  showVoiceStage(true);
  startVoiceClock();
  clearTimeout(voiceTimer);
  voiceTimer = 0;
  try { rec.start(1000); } catch { rec.start(); }
}

function toggleChat(open) {
  const panel = $("chat-panel");
  const next = typeof open === "boolean" ? open : panel.hidden;
  panel.hidden = !next;
  $("chat-open").setAttribute("aria-expanded", next ? "true" : "false");
  if (next) {
    setChatAlert(false);
    paintChatMate();
    $("chat-input").focus();
  }
}

function rankPlace(row) {
  if (!row) return "Pas dans ce classement";
  const place = Number(row.rank);
  return `${place}${place === 1 ? "er" : "e"} sur ${row.people}`;
}

function sameNames(rows, name) {
  const key = foldName(name);
  return (rows || []).filter((row) => foldName(row.name) === key);
}

function mateLine(label, rows, row) {
  if (rows.length > 1) return `<p><span>${label}</span> Plusieurs profils ont ce nom.</p>`;
  if (!row) return `<p><span>${label}</span> · Pas dans ce classement.</p>`;
  return `<p><span>${label}</span> · ${esc(rankPlace(row))}</p>`;
}

async function paintMate(player) {
  const card = $("mate-card");
  if (!card) return;
  if (!player?.name) {
    setMatePlayer("");
    card.hidden = true;
    card.replaceChildren();
    return;
  }
  const key = mateKey;
  card.hidden = false;
  if (player.kind === "ai") {
    setMatePlayer("");
    card.innerHTML = `${mateLine("Classement général", [], null)}${mateLine("En ligne", [], null)}`;
    return;
  }
  setMatePlayer("");
  card.innerHTML = `<p>Chargement…</p>`;
  const [general, online] = await Promise.all([
    sendJson(`/api/ranking?player=${encodeURIComponent(playerId())}&board=general`, "GET"),
    sendJson(`/api/ranking?player=${encodeURIComponent(playerId())}&board=online`, "GET"),
  ]);
  if (key !== mateKey) return;
  const generalRows = sameNames(general, player.name);
  const onlineRows = sameNames(online, player.name);
  const one = (rows) => (rows.length === 1 ? rows[0] : null);
  const ids = new Set([...generalRows, ...onlineRows].map((row) => row?.id).filter(Boolean));
  setMatePlayer(ids.size === 1 ? [...ids][0] : "");
  card.innerHTML = `${mateLine("Classement général", generalRows, one(generalRows))}${mateLine("En ligne", onlineRows, one(onlineRows))}`;
}

function setMatePlayer(id) {
  const title = $("chat-mate");
  if (!title) return;
  if (id) title.dataset.player = id;
  else delete title.dataset.player;
}

function openSeatCard(seat) {
  const player = app.players?.[seat];
  if (!player || player.kind === "ai") {
    toast("Pas de fiche pour ce joueur.");
    return;
  }
  const mine = app.mode === "online" ? app.seat : 0;
  const id = seat === mine ? playerId() : ($("chat-mate")?.dataset.player || "");
  if (id) showPlayerCard(id);
  else toast("Pas de fiche pour ce joueur.");
}

function fitChatInput() {
  const input = $("chat-input");
  if (!input) return;
  input.style.height = "auto";
  input.style.height = `${Math.min(96, Math.max(36, input.scrollHeight))}px`;
  const log = $("chat-log");
  if (log) log.scrollTop = log.scrollHeight;
}

function sendChat(event) {
  event.preventDefault();
  const input = $("chat-input");
  const text = input.value.trim().slice(0, 200);
  if (!text) return;
  if (app.mode === "online" && (!app.socket?.connected || !app.roomCode)) {
    toast("La discussion n'est pas disponible.");
    return;
  }
  appendChat(text, true);
  input.value = "";
  fitChatInput();
  if (app.mode === "online") app.socket.emit("chat", text);
}

function dropOnlineRoom() {
  const joined = app.mode === "online" || Boolean(sessionStorage.getItem("egmon-room"));
  app.ignoreOnline = true;
  app.holdRejoin = false;
  if (joined) app.socket?.emit("leave");
  try { sessionStorage.removeItem("egmon-room"); } catch { /* ignore */ }
  app.mode = null;
  app.game = null;
  cancelVoice();
  app.roomCode = null;
  app.chatRoom = "";
  $("chat-log")?.replaceChildren();
  mateKey = "";
  const mate = $("mate-card");
  if (mate) {
    mate.hidden = true;
    mate.replaceChildren();
  }
  const note = $("chat-note");
  if (note) note.hidden = true;
  setChatAlert(false);
  announcePresence();
}

let allowLeave = false;

function inLiveMatch() {
  return Boolean(app.game && app.game.status === "playing" && !$("screen-game").hidden);
}

function holdSurface() {
  if (!$("screen-game").hidden && app.game) return "game";
  if (!$("screen-lobby").hidden) return "lobby";
  if (app.game && app.game.status === "playing") return "game";
  return "";
}

function confirmLeave(onYes, lobby = false) {
  const finished = !lobby && app.game?.status === "finished";
  askDialog({
    kicker: "Quitter",
    title: lobby ? "Quitter la salle ?" : "Quitter la partie ?",
    text: lobby
      ? "Tu vas sortir de la salle."
      : finished
        ? "Tu restes sur la partie tant que tu n’as pas confirmé."
        : app.mode === "online"
          ? "L’adversaire sera déclaré vainqueur."
          : "La partie en cours sera arrêtée.",
    confirm: "Quitter",
    cancel: "Rester",
    onYes,
  });
}

function leaveOnlineScreen() {
  dropOnlineRoom();
  hideOverlay();
  allowLeave = false;
  show("screen-modes", "replace");
}

function goHome() {
  try { sessionStorage.removeItem(MATCH_KEY); } catch { /* ignore */ }
  const online = app.mode === "online" || history.state?.flow === "online";
  if (app.mode === "online" && app.game?.status === "playing") {
    app.game.winner = 1 - app.seat;
    app.game.reason = "abandon";
    app.game.status = "finished";
    recordGame();
  }
  if (online) dropOnlineRoom();
  else app.ignoreOnline = true;
  app.game = null;
  app.paused = false;
  app.mode = null;
  hideOverlay();
  announcePresence();
  show("screen-home", online || allowLeave ? "replace" : "push");
  allowLeave = false;
}

function confirmAbandon() {
  showOverlay({
    kicker: "Abandon",
    title: "Quitter cette partie ?",
    text: "L’adversaire sera déclaré vainqueur.",
    actions: [
      {
        label: "Abandonner",
        primary: true,
        on: () => {
          if (app.mode === "online") {
            app.socket.emit("abandon");
            return;
          }
          abandon(app.game, app.mode === "solo" ? 0 : app.game.current);
          endLocal();
        },
      },
      {
        label: "Continuer",
        on: () => {
          if (app.paused) showPause();
          else if (app.game?.status === "finished") showResult();
          else hideOverlay();
        },
      },
    ],
  });
}

function showPause() {
  app.paused = true;
  showOverlay({
    kicker: "Pause",
    title: "Partie en pause",
    text: "Le chronomètre est arrêté.",
    actions: [
      {
        label: "Reprendre",
        primary: true,
        on: () => {
          app.paused = false;
          hideOverlay();
          if (app.mode === "solo" && app.players[app.game.current]?.kind === "ai") queueAi();
        },
      },
      { label: "Abandonner", on: () => confirmAbandon() },
      { label: "Accueil", on: () => confirmLeave(() => goHome()) },
    ],
  });
}

function loop(ts) {
  const dt = app.lastTs ? Math.max(0, ts - app.lastTs) : 0;
  app.lastTs = ts;
  if (app.game && app.mode !== "online" && !app.paused && app.game.status === "playing") {
    const clock = tick(app.game, dt);
    if (app.challengeId) app.challengeMs = (app.challengeMs || 0) + dt;
    const verdict = immediateChallengeVerdict();
    if (verdict) finishChallenge(verdict);
    else if (clock.timedOut && clock.kind === "turn") onTurnTimeout();
    else if (clock.timedOut && clock.kind === "global") endLocal();
  }
  app.board?.frame(ts);
  if (app.game && !$("screen-game").hidden) updateTimers();
  requestAnimationFrame(loop);
}

let rejoinSince = 0;

function rejoinSavedRoom() {
  if (app.ignoreOnline || !app.socket?.connected) return;
  const saved = sessionStorage.getItem("egmon-room");
  if (!saved) return;
  try {
    const { code } = JSON.parse(saved);
    if (!code) return;
    if (!rejoinSince) rejoinSince = Date.now();
    const tryRejoin = () => {
      if (app.ignoreOnline || !readRoomSnap()) return;
      app.socket.emit("rejoin", { playerId: playerId(), code }, (res) => {
        if (res?.ok) {
          rejoinSince = 0;
          return;
        }
        if (app.ignoreOnline) return;
        if (Date.now() - rejoinSince < 45_000) {
          window.setTimeout(tryRejoin, 2000);
          return;
        }
        rejoinSince = 0;
        try { sessionStorage.removeItem("egmon-room"); } catch { /* ignore */ }
        if (!$("screen-lobby").hidden || !$("screen-game").hidden) {
          toast("La salle n’est plus ouverte.");
          leaveOnlineScreen();
        }
      });
    };
    tryRejoin();
  } catch {
    sessionStorage.removeItem("egmon-room");
  }
}

function ensureSocket() {
  if (!window.io) return null;
  if (app.socket) return app.socket;
  app.socket = window.io({ autoConnect: false });
  app.socket.on("connect", () => {
    clearTimeout(app.reconnectNote);
    app.selfBackAt = null;
    announcePresence();
    if (app.ignoreOnline) return;
    if (app.holdRejoin) {
      app.rejoinAfterHold = true;
      return;
    }
    rejoinSavedRoom();
  });
  app.socket.on("state", (msg) => onOnlineState(msg));
  app.socket.on("react", (msg) => {
    if (app.ignoreOnline || !msg || msg.code !== app.roomCode) return;
    if (msg.seat === app.seat) return;
    showReaction(msg.emoji, msg.seat);
  });
  app.socket.on("chat", (msg) => {
    if (!msg || msg.code !== app.roomCode || msg.seat === app.seat) return;
    appendChat(msg.text, false);
    if ($("chat-panel").hidden) noteIncomingChat();
  });
  app.socket.on("voice", (msg) => {
    if (!msg || msg.code !== app.roomCode) return;
    const mine = msg.seat === app.seat;
    appendChat("", mine, msg.audio, msg.id, msg.seconds);
    if (!mine && $("chat-panel").hidden) noteIncomingChat();
  });
  app.socket.on("chat-log", (msg) => {
    if (!msg || msg.code !== app.roomCode || !Array.isArray(msg.lines)) return;
    const log = $("chat-log");
    log.replaceChildren();
    for (const line of msg.lines) appendChat(line.text, line.seat === app.seat, line.audio, line.id, line.seconds);
    log.scrollTop = log.scrollHeight;
    const last = msg.lines.at(-1);
    if (last && last.seat !== app.seat && $("chat-panel").hidden) noteIncomingChat();
  });
  app.socket.on("closed", () => {
    if (app.ignoreOnline) return;
    toast("Le créateur a quitté la salle.");
    leaveOnlineScreen();
  });
  app.socket.on("notice", (text) => {
    if (text === "La table n’a pas pu s’ouvrir." || text === "Tu es déjà dans une partie." || text === "Cette personne est occupée.") toast(text);
  });
  app.socket.on("queue", (msg) => {
    if (!$("screen-find").hidden) renderFind(Array.isArray(msg.people) ? msg.people : []);
  });
  app.socket.on("invite", ({ from, token }) => {
    askDialog({
      kicker: "En ligne",
      title: `${from} veut jouer`,
      text: "Tu acceptes de rejoindre sa table ?",
      confirm: "Accepter",
      cancel: "Plus tard",
      onYes: () => {
        app.ignoreOnline = false;
        app.socket.emit("invite-answer", { token, yes: true });
      },
    });
  });
  app.socket.on("disconnect", (reason) => {
    if (reason === "io client disconnect" || app.ignoreOnline) return;
    const playing = app.mode === "online" && !$("screen-game").hidden;
    const waiting = !$("screen-lobby").hidden;
    if (!playing && !waiting) return;
    if (playing) {
      app.selfBackAt = Date.now() + 50_000;
      app.inputLock = false;
      clearTimeout(app.moveWatch);
    }
    clearTimeout(app.reconnectNote);
    app.reconnectNote = setTimeout(() => {
      if (app.socket?.connected || app.ignoreOnline) return;
      if (playing && !$("screen-game").hidden) {
        paintDisconnectBanner();
        return;
      }
      if (!$("screen-lobby").hidden) $("lobby-status").textContent = "Connexion coupée. Retour en cours…";
    }, 1500);
  });
  return app.socket;
}

function loadSocketScript() {
  if (window.io) return Promise.resolve();
  if (loadSocketScript.pending) return loadSocketScript.pending;
  loadSocketScript.pending = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = new URL("socket.io/socket.io.js", document.baseURI).href;
    script.onload = () => (window.io ? resolve() : reject(new Error("offline")));
    script.onerror = () => reject(new Error("offline"));
    document.head.appendChild(script);
  });
  return loadSocketScript.pending;
}

let socketReady = null;

function connectSocket() {
  return loadSocketScript().then(() => {
    const socket = ensureSocket();
    if (!socket) return Promise.reject(new Error("offline"));
    if (socket.connected) return Promise.resolve();
    if (socketReady) return socketReady;
    socketReady = new Promise((resolve, reject) => {
      const finish = (ok) => {
        clearTimeout(timer);
        socket.off("connect", onConnect);
        socketReady = null;
        if (ok) resolve();
        else reject(new Error("offline"));
      };
      const onConnect = () => finish(true);
      const timer = setTimeout(() => finish(false), 10000);
      socket.on("connect", onConnect);
      if (socket.disconnected) socket.connect();
    });
    return socketReady;
  });
}

function sendInRoom(event) {
  const snap = readRoomSnap();
  const code = snap?.code || app.roomCode;
  const run = () => app.socket.emit(event);
  if (!app.socket?.connected || !code) {
    connectSocket().then(() => {
      app.socket.emit("rejoin", { playerId: playerId(), code }, (res) => {
        if (res?.ok) run();
        else toast("La salle n’est plus ouverte.");
      });
    }).catch(() => toast("La connexion a sauté. Réessaie."));
    return;
  }
  app.socket.emit("rejoin", { playerId: playerId(), code }, (res) => {
    if (res?.ok) run();
    else toast("La salle n’est plus ouverte.");
  });
}

function emitAck(event, payload) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), 8000);
    app.socket.emit(event, payload, (res) => {
      clearTimeout(timer);
      resolve(res);
    });
  });
}

function onOnlineState(msg) {
  if (app.ignoreOnline) return;
  app.mode = "online";
  if (app.chatRoom !== msg.code) {
    app.chatRoom = msg.code;
    $("chat-log")?.replaceChildren();
    mateKey = "";
    const mate = $("mate-card");
    if (mate) {
      mate.hidden = true;
      mate.replaceChildren();
    }
    setChatAlert(false);
    app.socket?.emit("chat-sync");
  }
  app.roomCode = msg.code;
  app.seat = msg.you;
  sessionStorage.setItem("egmon-room", JSON.stringify({
    code: msg.code,
    playerId: playerId(),
    you: msg.you,
    settings: msg.settings,
    seats: msg.seats,
    ready: msg.ready,
    accepted: msg.accepted === true,
    playing: Boolean(msg.game),
    direct: msg.direct === true,
    game: msg.game || null,
  }));
  app.players = [0, 1].map((index) => {
    const seat = msg.seats[index] || {};
    return {
      name: seat.name || (index === 0 ? msg.settings.p1Name : msg.settings.p2Name) || "…",
      color: seat.color || (index === 0 ? msg.settings.p1Color : msg.settings.p2Color),
      kind: "human",
      connected: seat.connected !== false,
    };
  });
  app.prefs = {
    ...app.prefs,
    ...msg.settings,
    theme: msg.direct ? "classic" : app.prefs.theme,
    penStyle: app.prefs.penStyle,
    sound: app.prefs.sound,
  };
  app.game = msg.game;
  if (msg.game) {
    app.clockSync = {
      global: msg.game.globalRemaining,
      turn: msg.game.turnRemaining,
      at: performance.now(),
    };
  }
  const foeSeat = msg.seats?.[1 - app.seat];
  app.selfBackAt = null;
  app.foeBackAt = msg.game?.status === "playing" && foeSeat?.connected === false && Number(foeSeat.forfeitAt) > 0
    ? Number(foeSeat.forfeitAt)
    : null;
  if (!app.foeBackAt) $("conn-banner").hidden = true;
  else paintDisconnectBanner();
  if (!msg.game) {
    renderLobby(msg);
    show("screen-lobby", "replace");
    announcePresence();
    return;
  }
  const event = msg.event || {};
  if (event.type === "rematch" || event.type === "start") {
    app.rematchOffer = "";
    app.board.clearAnims();
    app.recorded = false;
    app.inputLock = false;
    app.paused = false;
    hideOverlay();
    resetSheetZoom();
  }
  show("screen-game", "replace");
  paintMatch();
  if (event.type === "move" || event.type === "timeout") {
    clearTimeout(app.moveWatch);
    app.board.animate(event.move, event.result);
    app.sounds.line();
    if (event.result?.completed) {
      app.sounds.box();
      popScore(event.result.player);
    }
    if (event.result?.eaten) popScore(1 - event.result.player);
    if (event.type === "timeout") toast("Temps écoulé : un point a été posé.");
    app.inputLock = true;
    window.setTimeout(() => {
      app.inputLock = false;
      if (app.game?.status === "finished") finishOnline();
    }, 240 + (event.result?.completed || 0) * 180);
    announcePresence();
    return;
  }
  if (event.type === "rematch-wait") {
    app.rematchOffer = msg.rematch?.[app.seat] ? "mine" : "theirs";
  }
  if (event.type === "rematch-no") {
    app.rematchOffer = "";
    toast("Revanche refusée.");
  }
  if (app.game.status === "finished") finishOnline();
  else announcePresence();
}

function tableText(settings) {
  const minutes = Math.round((Number(settings.timeLimit) || 0) / 60);
  const time = settings.timeMode === "global" ? `${minutes} min` : "Illimité";
  const score = Number(settings.scoreLimit) > 0 ? `Premier à ${settings.scoreLimit}` : "Toute la feuille";
  return `${time} · ${score}`;
}

function renderLobby(msg) {
  const mine = msg.you;
  const seats = msg.seats || [];
  $("lobby-code").textContent = msg.code;
  $("lobby-code").hidden = msg.direct === true;
  $("lobby-share").hidden = msg.direct === true || mine !== 0;
  $("lobby-rules").textContent = tableText(msg.settings);
  $("lobby-seats").innerHTML = [0, 1].map((index) => {
    const seat = seats[index] || {};
    const label = seat.present ? esc(seat.name || "Joueur") : "Place libre";
    const state = !seat.present
      ? "En attente"
      : msg.ready?.[index]
        ? "Ok"
        : seat.connected === false
          ? "Déconnecté"
          : "Pas encore confirmé";
    return `<p><strong>${label}</strong><span>${state}</span></p>`;
  }).join("");
  const ready = msg.ready?.[0] && msg.ready?.[1];
  $("lobby-status").textContent = !seats[1]?.present
    ? msg.direct
      ? "La partie attend que l’autre arrive."
      : "Donne le code. La partie attend que l’autre arrive."
    : !ready
      ? "Les deux doivent confirmer leur présence."
      : "Vous pouvez passer à la table.";
  const here = msg.ready?.[mine] === true;
  $("lobby-present").disabled = here;
  $("lobby-present").setAttribute("aria-pressed", here ? "true" : "false");
  $("lobby-present").textContent = here ? "Ok" : "Je suis là";
  $("lobby-launch").hidden = mine !== 0 || !ready;
  $("lobby-launch").disabled = !ready;
}

function readRoomSnap() {
  try {
    const snap = JSON.parse(sessionStorage.getItem("egmon-room") || "null");
    return snap?.code ? snap : null;
  } catch {
    return null;
  }
}

function resumeSavedRoom() {
  const snap = readRoomSnap();
  if (!snap) return false;
  app.ignoreOnline = false;
  app.mode = "online";
  app.roomCode = snap.code;
  app.seat = Number(snap.you) || 0;
  if (snap.playing) {
    if (snap.game?.dots) {
      app.game = snap.game;
      app.players = [0, 1].map((index) => {
        const seat = Array.isArray(snap.seats) ? (snap.seats[index] || {}) : {};
        return {
          name: seat.name || "Joueur",
          color: seat.color || (index === 0 ? "blue" : "red"),
          kind: "human",
          connected: seat.connected !== false,
        };
      });
    }
    show("screen-game", "skip");
    if (app.game) paintMatch();
    const banner = $("conn-banner");
    banner.hidden = false;
    banner.textContent = "Reprise de la partie…";
  } else {
    renderLobby({
      code: snap.code,
      you: app.seat,
      settings: snap.settings || {},
      seats: Array.isArray(snap.seats) ? snap.seats : [],
      ready: Array.isArray(snap.ready) ? snap.ready : [false, false],
      accepted: snap.accepted === true,
      direct: snap.direct === true,
    });
    $("lobby-status").textContent = "Reprise de la salle…";
    show("screen-lobby", "skip");
  }
  connectSocket().catch(() => {
    if (!$("screen-lobby").hidden) $("lobby-status").textContent = "Connexion coupée. La salle est gardée.";
    toast("La connexion a sauté. Réessaie dans un instant.");
  });
  return true;
}

function renderFind(people) {
  const list = $("find-list");
  if (!people.length) {
    list.innerHTML = `<p class="empty">Personne d’autre n’est connecté pour le moment.</p>`;
    return;
  }
  list.innerHTML = people.map((person) => {
    const busy = person.busy === true || person.activity === "duo" || person.activity === "robot";
    const state = person.activity === "robot"
      ? "Occupé · match robot"
      : busy
        ? "Occupé · match à 2"
        : "Libre";
    return `<button type="button" class="find-card${busy ? " is-taken" : ""}" data-token="${esc(person.token)}" data-busy="${busy ? "1" : "0"}"${busy ? " disabled" : ""}><span class="face">${faceMarkup(person.photo, true)}</span><span class="find-copy"><strong>${esc(person.name)}</strong><span class="find-state">${state}</span></span></button>`;
  }).join("");
  bindFaceImages(list);
}

function matchActivity() {
  if (app.game?.status === "finished") return "";
  if (app.mode === "online" && (app.game?.status === "playing" || app.roomCode || readRoomSnap())) return "duo";
  if (app.mode === "local" && app.game?.status === "playing") return "duo";
  if (app.mode === "solo" && app.game?.status === "playing") return "robot";
  return "";
}

function matchBusy() {
  return matchActivity() !== "";
}

let presenceSent = "";

function announcePresence() {
  const profile = loadProfile();
  const name = (profile.name || "").trim();
  if (!name) return;
  const activity = matchActivity();
  const key = `${activity}|${name}|${profile.photo || ""}`;
  if (presenceSent === key) return;
  presenceSent = key;
  const send = () => {
    if (!app.socket?.connected) return;
    app.socket.emit("presence", {
      playerId: playerId(),
      name,
      photo: profile.photo || "",
      busy: activity !== "",
      activity,
    });
  };
  if (app.socket?.connected) send();
  else connectSocket().then(send).catch(() => {});
}

async function enterQueue() {
  app.ignoreOnline = false;
  try {
    await connectSocket();
  } catch {
    $("find-list").innerHTML = `<p class="empty">La liste n’a pas pu se charger. Réessaie.</p>`;
    toast("La liste des joueurs est indisponible. Réessaie.");
    return;
  }
  if ($("screen-find").hidden) return;
  const profile = loadProfile();
  app.queued = true;
  app.socket.emit("queue-join", {
    playerId: playerId(),
    name: profile.name || "Joueur",
    photo: profile.photo || "",
    busy: matchBusy(),
    activity: matchActivity(),
    settings: {
      rows: 32,
      cols: 24,
      extraTurn: true,
      timeMode: "none",
      scoreLimit: 10,
      theme: "classic",
      closeMode: "auto",
      p1Color: "blue",
      p2Color: "black",
      p1Name: profile.name || "Joueur",
    },
  });
}

function finishOnline() {
  recordGame();
  showResult();
  announcePresence();
}

async function createOnlineRoom(settings) {
  const name = settings?.p1Name || loadProfile().name || "Joueur";
  const chosen = { ...app.prefs, ...settings, p1Name: name };
  const button = $("setup-go");
  if (button?.disabled) return;
  if (button) {
    button.disabled = true;
    button.textContent = "Ouverture…";
  }
  app.ignoreOnline = false;
  app.holdRejoin = true;
  try {
    await connectSocket();
    const res = await emitAck("create", { playerId: playerId(), name, settings: chosen });
    if (!res?.ok) toast(res?.error || "La salle n’a pas pu s’ouvrir. Réessaie.");
  } catch {
    toast("La salle n’a pas pu s’ouvrir. Réessaie.");
  } finally {
    app.holdRejoin = false;
    if (app.rejoinAfterHold) {
      app.rejoinAfterHold = false;
      rejoinSavedRoom();
    }
    if (button) {
      button.disabled = false;
      button.textContent = "Créer la salle";
    }
  }
}

async function joinRoom(code, color) {
  const button = $("join-form")?.querySelector("[type=submit]");
  if (button?.disabled) return;
  if (button) {
    button.disabled = true;
    button.textContent = "Entrée…";
  }
  app.ignoreOnline = false;
  app.holdRejoin = true;
  try {
    await connectSocket();
    app.socket.emit("leave");
    const res = await emitAck("join", {
      playerId: playerId(),
      name: $("join-name").value,
      code,
      color,
    });
    if (!res?.ok) toast(res?.error || "Impossible de rejoindre. Réessaie.");
    return res;
  } catch {
    toast("Impossible de rejoindre. Réessaie.");
    return null;
  } finally {
    app.holdRejoin = false;
    if (app.rejoinAfterHold) {
      app.rejoinAfterHold = false;
      rejoinSavedRoom();
    }
    if (button) {
      button.disabled = false;
      button.textContent = "Rejoindre";
    }
  }
}

function noteAdmin(profile) {
  app.admin = profile?.admin === true;
  const button = $("go-admin");
  if (button) button.hidden = !app.admin;
}

function adminDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

const ADMIN_RANGES = [
  ["today", "Aujourd’hui"],
  ["yesterday", "Hier"],
  ["week", "7 jours"],
  ["month", "Ce mois"],
  ["days30", "30 jours"],
];
const ADMIN_RANGE_TEXT = {
  today: "aujourd’hui",
  yesterday: "hier",
  week: "sur 7 jours",
  month: "ce mois",
  days30: "sur 30 jours",
};
let adminData = null;
let adminRange = "week";
let adminPick = "";

function shiftDay(day, delta) {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

function adminDayLabel(day) {
  const date = new Date(`${day}T12:00:00`);
  if (Number.isNaN(date.getTime())) return day;
  return date.toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
}

function adminWindow(days) {
  const today = days.at(-1)?.day || "";
  if (!today) return [];
  if (adminRange === "today") return days.filter((item) => item.day === today);
  if (adminRange === "yesterday") {
    const yesterday = shiftDay(today, -1);
    return days.filter((item) => item.day === yesterday);
  }
  if (adminRange === "week") return days.slice(-7);
  if (adminRange === "month") return days.filter((item) => item.day.slice(0, 7) === today.slice(0, 7));
  return days.slice(-30);
}

function adminBars(host, days, key, unit) {
  host.replaceChildren();
  const max = Math.max(1, ...days.map((item) => Number(item[key]) || 0));
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 280 88");
  svg.setAttribute("role", "img");
  const slot = 280 / Math.max(1, days.length);
  days.forEach((item, index) => {
    const value = Number(item[key]) || 0;
    const height = value ? Math.max(4, Math.round((value / max) * 74)) : 2;
    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("x", String(index * slot + 2));
    rect.setAttribute("y", String(80 - height));
    rect.setAttribute("width", String(Math.max(2, slot - 4)));
    rect.setAttribute("height", String(height));
    rect.setAttribute("rx", "2");
    if (adminPick === item.day) rect.classList.add("is-on");
    const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
    title.textContent = `${adminDayLabel(item.day)} · ${value}`;
    rect.append(title);
    rect.addEventListener("click", () => {
      adminPick = adminPick === item.day ? "" : item.day;
      if (adminData) renderAdmin(adminData);
    });
    svg.append(rect);
  });
  host.append(svg);
  const caption = document.createElement("p");
  const picked = days.find((item) => item.day === adminPick);
  if (picked) caption.textContent = `${adminDayLabel(picked.day)} · ${Number(picked[key]) || 0} ${unit}`;
  else if (days.length === 1) caption.textContent = `${adminDayLabel(days[0].day)} · ${Number(days[0][key]) || 0} ${unit}`;
  else if (days.length) caption.textContent = `${adminDayLabel(days[0].day)} – ${adminDayLabel(days.at(-1).day)}`;
  host.append(caption);
}

let adminWatch = 0;

function stopAdminWatch() {
  clearInterval(adminWatch);
  adminWatch = 0;
}

function renderAdmin(data) {
  adminData = data;
  const live = data.live || {};
  $("admin-live").innerHTML = [
    [live.connected, "Connectés"],
    [live.playing, "Personnes qui jouent"],
    [live.matches ?? ((Number(live.playingRooms) || 0) + (Number(live.robotPlayers) || 0)), "Parties en cours"],
    [live.playingRooms, "Matchs en ligne"],
    [live.robotPlayers, "Matchs robot"],
    [live.waitingRooms, "Tables en attente"],
  ].map(([value, label]) => `<p><strong>${Number(value) || 0}</strong><span>${label}</span></p>`).join("");
  const stats = $("admin-stats");
  const cards = [
    [data.people, "Personnes"],
    [data.accounts, "Comptes"],
    [data.games, "Parties"],
    [data.online, "En ligne"],
    [data.messages, "Messages"],
  ];
  stats.innerHTML = cards.map(([value, label]) => `<p><strong>${Number(value) || 0}</strong><span>${label}</span></p>`).join("");
  const filters = $("admin-filters");
  filters.replaceChildren();
  for (const [id, label] of ADMIN_RANGES) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.classList.toggle("is-on", adminRange === id);
    button.addEventListener("click", () => {
      adminRange = id;
      adminPick = "";
      renderAdmin(data);
    });
    filters.append(button);
  }
  const reach = data.reach || {};
  const people = Number(reach[adminRange]) || 0;
  $("admin-reach").textContent = `${people} personne${people > 1 ? "s" : ""} connectée${people > 1 ? "s" : ""} ${ADMIN_RANGE_TEXT[adminRange] || ""}`;
  const days = adminWindow(data.days || []);
  if (adminPick && !days.some((item) => item.day === adminPick)) adminPick = "";
  adminBars($("admin-chart-people"), days, "connected", "personnes");
  adminBars($("admin-chart-games"), days, "games", "parties");
  adminBars($("admin-chart-online"), days, "online", "en ligne");
  const players = $("admin-players");
  players.innerHTML = (data.players || []).length
    ? data.players.map((player) => {
      const games = `${player.games} partie${player.games > 1 ? "s" : ""}`;
      const online = player.online ? ` · ${player.online} en ligne` : "";
      const when = player.lastPlayed ? adminDate(player.lastPlayed) : "Aucune partie";
      return `<article class="history-item"><div><strong>${esc(player.name || "Sans nom")}</strong><span>${esc(player.email || "Sans e-mail")}</span></div><div><b>${esc(games)}${esc(online)}</b><span>${esc(when)}</span></div></article>`;
    }).join("")
    : `<p class="empty">Aucun joueur.</p>`;
  const notes = $("admin-messages");
  notes.innerHTML = (data.notes || []).length
    ? data.notes.map((note) => `<article class="history-item admin-note"><div><strong>${esc(note.name || "Sans nom")}</strong><span>${esc(adminDate(note.at))}</span><p>${esc(note.body || "")}</p></div></article>`).join("")
    : `<p class="empty">Aucun message.</p>`;
}

async function loadAdmin() {
  const data = await sendJson("/api/admin", "GET");
  if ($("screen-admin").hidden) return;
  if (!data || !Array.isArray(data.days)) {
    if (adminWatch) return;
    noteAdmin(null);
    toast("Cette page n'est pas disponible.");
    show("screen-modes", "replace");
    return;
  }
  noteAdmin({ admin: true });
  renderAdmin(data);
  if (!adminWatch) adminWatch = setInterval(loadAdmin, 15000);
}

let gameStats = null;

function tallyHistory(items) {
  const box = { played: items.length, wins: 0, losses: 0, draws: 0 };
  for (const item of items) {
    if (item.winner === "draw") {
      box.draws += 1;
      continue;
    }
    const seat = Number(item.userSeat);
    if (seat !== 0 && seat !== 1) continue;
    if (Number(item.winner) === seat) box.wins += 1;
    else box.losses += 1;
  }
  return box;
}

function paintStat(prefix, box) {
  const node = (name) => $(prefix ? `stat-${prefix}-${name}` : `stat-${name}`);
  const played = node("played");
  const wins = node("wins");
  const losses = node("losses");
  const draws = node("draws");
  if (played) played.textContent = String(Number(box?.played) || 0);
  if (wins) wins.textContent = String(Number(box?.wins) || 0);
  if (losses) losses.textContent = String(Number(box?.losses) || 0);
  if (draws) draws.textContent = String(Number(box?.draws) || 0);
}

function renderHistory() {
  const history = loadHistory();
  const general = gameStats?.general || tallyHistory(history);
  const online = gameStats?.online || tallyHistory(history.filter((item) => item.mode === "online"));
  paintStat("", general);
  paintStat("online", online);
  const list = $("history-list");
  if (!history.length) {
    list.innerHTML = `<p class="empty">Aucune partie enregistrée. Le papier est encore vierge.</p>`;
    return;
  }
  const modeLabel = { solo: "Robot", local: "2 joueurs", online: "En ligne" };
  list.innerHTML = history.map((item) => {
    let result = "Égalité";
    if (item.winner === 0 || item.winner === 1) {
      result = item.userSeat == null
        ? `${esc(item.names[item.winner])} gagne`
        : item.winner === item.userSeat ? "Victoire" : "Défaite";
    }
    const when = new Date(item.at).toLocaleString("fr-FR", {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
    const diff = item.difficulty ? ` · ${DIFF_LABEL[item.difficulty] || ""}` : "";
    const left = Number(item.scores?.[0]) || 0;
    const right = Number(item.scores?.[1]) || 0;
    const names = Array.isArray(item.names) ? item.names : [];
    const foeIndex = item.userSeat === 1 ? 0 : 1;
    const foe = item.mode === "online" ? (names[foeIndex] || "Adversaire") : "";
    const mine = item.userSeat === 0 || item.userSeat === 1 ? item.userSeat : null;
    const myScore = mine == null ? left : (Number(item.scores?.[mine]) || 0);
    const foeScore = mine == null ? right : (Number(item.scores?.[1 - mine]) || 0);
    const cause = item.mode === "online" && REASON[item.reason] ? ` · ${REASON[item.reason]}` : "";
    const detail = item.mode === "online"
      ? `Contre ${esc(foe)} · ${esc(item.size || "")}${esc(cause)}`
      : `${esc(item.size)} · ${modeLabel[item.mode] || ""}${esc(diff)}`;
    const score = item.mode === "online" ? `${myScore} – ${foeScore}` : `${left} – ${right}`;
    return `<article class="history-item"><div><strong>${result}</strong><span>${detail}</span></div><div><b>${score}</b><span>${esc(when)}</span></div></article>`;
  }).join("");
}

function copyText(text, done = "Copié.") {
  navigator.clipboard?.writeText(text).then(() => toast(done)).catch(() => toast(text));
}

function roomLink(code) {
  const url = new URL(location.href);
  url.hash = "";
  url.search = "";
  url.searchParams.set("room", code);
  return url.toString();
}

function copyRoomLink() {
  const code = String(app.roomCode || $("lobby-code").textContent || "").trim().toUpperCase();
  if (!/^EGD-[A-Z2-9]{6}$/.test(code)) {
    toast("Le lien n’est pas encore prêt.");
    return;
  }
  copyText(roomLink(code), "Lien copié.");
}

function soon() {
  toast("Bientôt disponible.");
}

const HUB_TITLES = {
  play: "Jouer une partie",
  challenges: "Défis",
  competitions: "Compétitions",
  profiles: "Profils",
};

function savedHub() {
  try {
    const name = sessionStorage.getItem("egmon-hub") || "";
    return HUB_TITLES[name] ? name : "";
  } catch {
    return "";
  }
}

function openHub(name) {
  const next = HUB_TITLES[name] ? name : "";
  try {
    if (next) sessionStorage.setItem("egmon-hub", next);
    else sessionStorage.removeItem("egmon-hub");
  } catch { /* ignore */ }
  const home = $("mode-home");
  if (!home) return;
  home.hidden = Boolean(next);
  document.querySelectorAll("[data-hub-panel]").forEach((panel) => {
    panel.hidden = panel.dataset.hubPanel !== next;
  });
  $("modes-title").textContent = HUB_TITLES[next] || "Commencez";
  if (next === "challenges") {
    renderChallenges();
    const status = $("challenge-status");
    const panel = document.querySelector("[data-hub-panel=challenges]");
    const wait = window.setTimeout(() => {
      if (status && panel && !panel.hidden) status.textContent = "Mise à jour des défis…";
    }, 400);
    pullHistory().then((ok) => {
      window.clearTimeout(wait);
      if (!panel || panel.hidden) return;
      renderChallenges();
      if (!ok && status) status.textContent = "Affichés depuis cet appareil.";
    });
  }
}

const auth = { step: "identity", exists: false, name: "", email: "", accountId: "", knownMail: false };
let pendingRoom = "";

function firstNameGroup(name) {
  return String(name || "").trim().split(/\s+/)[0] || "";
}

function paintUserChip() {
  const chip = $("user-chip");
  const label = firstNameGroup(loadProfile().name);
  if (!chip) return;
  chip.hidden = !label;
  const slot = $("user-chip-name");
  if (slot) slot.textContent = label;
}

function isConnected() {
  const session = loadSession();
  return session?.connected === true && session.id === playerId() && Boolean(loadProfile().name);
}

function validRoomCode(value) {
  const code = String(value || "").trim().toUpperCase();
  return /^EGD-[A-Z2-9]{6}$/.test(code) ? code : "";
}

async function accountReady() {
  if (!isConnected()) return false;
  try {
    const response = await fetch(`/api/profile/${playerId()}`);
    if (response.status === 401) {
      saveSession(null);
      noteAdmin(null);
      paintUserChip();
      return false;
    }
    return true;
  } catch {
    return isConnected();
  }
}

async function claimRoomLink(code) {
  const room = validRoomCode(code);
  if (!room) return;
  pendingRoom = room;
  if (!(await accountReady())) {
    openAuth();
    return;
  }
  enterSharedRoom();
}

async function enterSharedRoom() {
  const code = pendingRoom;
  if (!code || !(await accountReady())) {
    if (code) openAuth();
    return;
  }
  const name = loadProfile().name || "";
  if ($("join-name")) $("join-name").value = name;
  if ($("join-code")) $("join-code").value = code;
  const res = await joinRoom(code, app.prefs.p2Color);
  if (!res?.ok) {
    const lead = $("online-lead");
    if (lead) {
      lead.hidden = false;
      lead.textContent = "Une invitation est prête. Entre le code, puis rejoins.";
    }
    show("screen-online");
    return;
  }
  pendingRoom = "";
  const url = new URL(location.href);
  url.searchParams.delete("room");
  history.replaceState(history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

function showAuthError(message) {
  const node = $("auth-error");
  node.hidden = false;
  node.textContent = message;
}

async function authFetch(url, body) {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return { ok: false, error: data.error || "" };
    return { ok: true, data };
  } catch {
    return { ok: false, error: "Réessaie dans un instant." };
  }
}

function hideSecrets() {
  for (const id of ["auth-password", "auth-confirm"]) {
    const input = $(id);
    if (input) input.type = "password";
  }
  document.querySelectorAll(".secret-see").forEach((button) => {
    button.classList.remove("is-on");
    button.setAttribute("aria-pressed", "false");
    button.setAttribute("aria-label", "Afficher le mot de passe");
  });
}

function showAuthFace(face) {
  auth.step = face === "password" ? "password" : face === "reset" ? "reset" : face === "recover" ? "recover" : "identity";
  const secretFace = face === "password" || face === "reset";
  $("auth-key-label").hidden = face !== "recover";
  $("auth-name-label").hidden = face === "password" || face === "email" || face === "add-email" || face === "recover" || face === "reset";
  $("auth-email-label").hidden = face === "password" || face === "recover" || face === "reset";
  $("auth-password-label").hidden = !secretFace;
  $("auth-confirm-label").hidden = face === "reset" ? false : face !== "password" || auth.exists;
  $("auth-forgot").hidden = face !== "password" || !auth.exists;
  $("auth-known").hidden = face !== "create";
  $("auth-error").hidden = true;
  if (face === "create") {
    auth.mode = "create";
    $("auth-kicker").textContent = "Création de compte";
    $("auth-title").textContent = "Votre profil";
    $("auth-text").textContent = "Écris ton nom et prénom, puis ton e-mail.";
    $("auth-go").textContent = "Continuer";
  } else if (face === "add-email") {
    auth.mode = "create";
    $("auth-kicker").textContent = "Profil";
    $("auth-title").textContent = "Votre profil";
    $("auth-text").textContent = "Vous aviez inséré le profil et non le mail. Veuillez ajouter le mail.";
    $("auth-go").textContent = "Continuer";
  } else if (face === "recover") {
    auth.mode = "login";
    $("auth-kicker").textContent = "Connexion";
    $("auth-title").textContent = "Votre profil";
    $("auth-text").textContent = "Écris le nom du profil ou l'e-mail.";
    $("auth-go").textContent = "Continuer";
  } else if (face === "email") {
    auth.mode = "login";
    $("auth-kicker").textContent = "Connexion";
    $("auth-title").textContent = "Votre e-mail";
    $("auth-text").textContent = "Entrez votre e-mail pour vous connecter.";
    $("auth-go").textContent = "Continuer";
  } else if (face === "reset") {
    auth.mode = "login";
    const known = auth.email ? `Vous aviez indiqué ${auth.email}. ` : "";
    $("auth-kicker").textContent = "Connexion";
    $("auth-title").textContent = "Mot de passe";
    $("auth-text").textContent = `${known}Choisis un nouveau mot de passe, puis confirme-le.`;
    $("auth-go").textContent = "Enregistrer";
    $("auth-password").autocomplete = "new-password";
    hideSecrets();
  } else {
    const known = auth.knownMail && auth.email ? `Vous aviez indiqué ${auth.email}. ` : "";
    $("auth-kicker").textContent = auth.exists ? "Connexion" : "Création de compte";
    $("auth-title").textContent = "Mot de passe";
    $("auth-text").textContent = auth.exists
      ? `${known}Écris le mot de passe que tu as créé.`
      : `${known}Choisis un mot de passe, puis confirme-le.`;
    $("auth-go").textContent = auth.exists ? "Entrer" : "Créer le profil";
    $("auth-password").autocomplete = auth.exists ? "current-password" : "new-password";
    hideSecrets();
  }
}

async function openAuth() {
  const profile = loadProfile();
  const name = profile.name.trim();
  const email = profile.email.trim();
  auth.exists = false;
  auth.mode = "create";
  auth.name = name;
  auth.email = "";
  auth.accountId = "";
  auth.knownMail = false;
  $("auth-name").value = "";
  $("auth-email").value = "";
  $("auth-key").value = "";
  $("auth-password").value = "";
  $("auth-confirm").value = "";

  if (email) {
    const looked = await authFetch("/api/auth/lookup", { email });
    if (looked.ok && looked.data.exists) {
      auth.exists = true;
      auth.mode = "login";
      auth.name = looked.data.name || name;
      auth.email = looked.data.email || email;
      auth.knownMail = true;
      showAuthFace("password");
      $("auth-dialog").hidden = false;
      window.setTimeout(() => $("auth-password").focus(), 30);
      return;
    }
  }

  if (name && !email) {
    showAuthFace("add-email");
    $("auth-dialog").hidden = false;
    window.setTimeout(() => $("auth-email").focus(), 30);
    return;
  }

  if (name && email) {
    auth.email = email;
    auth.exists = false;
    auth.knownMail = true;
    showAuthFace("password");
    $("auth-dialog").hidden = false;
    window.setTimeout(() => $("auth-password").focus(), 30);
    return;
  }

  showAuthFace("create");
  $("auth-dialog").hidden = false;
  window.setTimeout(() => $("auth-name").focus(), 30);
}

function alreadyAccount() {
  auth.mode = "login";
  auth.accountId = "";
  auth.knownMail = false;
  $("auth-key").value = "";
  showAuthFace("recover");
  window.setTimeout(() => $("auth-key").focus(), 30);
}

function forgotPassword() {
  if (!auth.exists || !auth.email) return;
  $("auth-password").value = "";
  $("auth-confirm").value = "";
  showAuthFace("reset");
  window.setTimeout(() => $("auth-password").focus(), 30);
}

function leaveAuth() {
  $("auth-dialog").hidden = true;
}

function authHelp() {
  $("auth-dialog").hidden = true;
  openFeedback();
}

function finishAuth(profile) {
  setPlayerId(profile.id);
  saveProfile({
    name: profile.name,
    email: profile.email,
    icon: profile.icon,
    photo: profile.photo,
  });
  saveSession({ connected: true, id: profile.id, email: profile.email });
  $("auth-dialog").hidden = true;
  paintUserChip();
  announcePresence();
  pullProfile();
  pullHistory();
  if (!$("screen-profile").hidden) fillProfileForm(loadProfile());
  if (pendingRoom) enterSharedRoom();
}

async function submitAuth(event) {
  event.preventDefault();
  const button = $("auth-go");
  button.disabled = true;
  try {
    await sendAuth(event);
  } finally {
    button.disabled = false;
  }
}

function applyFoundAccount(found) {
  auth.name = found.name || auth.name;
  auth.email = found.email || "";
  auth.accountId = found.id || "";
  auth.exists = Boolean(found.exists);
  auth.mode = auth.exists ? "login" : "create";
  auth.knownMail = Boolean(auth.email);
  $("auth-password").value = "";
  $("auth-confirm").value = "";
  if (!auth.email) {
    showAuthFace("add-email");
    window.setTimeout(() => $("auth-email").focus(), 30);
    return;
  }
  showAuthFace("password");
  window.setTimeout(() => $("auth-password").focus(), 30);
}

async function sendAuth() {
  if (auth.step === "recover") {
    const key = $("auth-key").value.trim();
    if (!key) {
      showAuthError("Écris ton nom ou ton e-mail.");
      return;
    }
    const looked = await authFetch("/api/auth/lookup", { key });
    if (!looked.ok) {
      showAuthError(looked.error || "Réessaie dans un instant.");
      return;
    }
    if (looked.data.many) {
      showAuthError("Plusieurs profils portent ce nom. Écris l'e-mail.");
      return;
    }
    if (!looked.data.found) {
      showAuthError("Aucun profil avec ce nom ou cet e-mail.");
      return;
    }
    applyFoundAccount(looked.data);
    return;
  }
  if (auth.step === "identity") {
    const name = loadProfile().name || $("auth-name").value.trim();
    const email = $("auth-email").value.trim();
    if (!name) {
      showAuthError("Écris ton nom et prénom.");
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      showAuthError("Cet e-mail n’est pas valide.");
      return;
    }
    const looked = await authFetch("/api/auth/lookup", { email });
    if (!looked.ok) {
      showAuthError(looked.error || "Réessaie dans un instant.");
      return;
    }
    if (!looked.data.exists) {
      if (auth.mode === "login") {
        showAuthError("Aucun compte avec cet e-mail.");
        return;
      }
      auth.exists = false;
    } else {
      auth.exists = true;
      auth.mode = "login";
      auth.knownMail = true;
      auth.accountId = "";
    }
    auth.name = looked.data.name || name;
    auth.email = looked.data.email || email;
    $("auth-password").value = "";
    $("auth-confirm").value = "";
    showAuthFace("password");
    $("auth-password").focus();
    return;
  }
  const password = $("auth-password").value;
  const creating = auth.step === "reset" || !auth.exists;
  if (password.length < 6) {
    showAuthError("Le mot de passe doit avoir au moins 6 caractères.");
    return;
  }
  if (creating && password !== $("auth-confirm").value) {
    showAuthError("Les deux mots de passe ne sont pas les mêmes.");
    return;
  }
  const result = auth.step === "reset"
    ? await authFetch("/api/auth/reset", { email: auth.email, password })
    : auth.exists
    ? await authFetch("/api/auth/login", { email: auth.email, password })
    : await authFetch("/api/auth/register", {
      playerId: auth.accountId || playerId(),
      name: auth.name,
      email: auth.email,
      password,
    });
  if (!result.ok) {
    showAuthError(result.error || "Réessaie dans un instant.");
    return;
  }
  finishAuth(result.data);
}

async function restoreAccount() {
  const session = loadSession();
  if (session?.id) setPlayerId(session.id);
  paintUserChip();
  if (!isConnected()) return;
  try {
      const response = await fetch(`/api/profile/${playerId()}`);
      if (response.status === 401) {
        saveSession(null);
        noteAdmin(null);
        paintUserChip();
      } else if (response.ok) {
        noteAdmin(await response.json());
      }
  } catch {
    /* la partie locale reste disponible */
  }
}

async function beginPlay() {
  const session = loadSession();
  if (session?.id) setPlayerId(session.id);
  if (isConnected()) {
    try {
      const response = await fetch(`/api/profile/${playerId()}`);
      if (response.status !== 401) {
        try { sessionStorage.removeItem("egmon-hub"); } catch { /* ignore */ }
        show("screen-modes");
        return;
      }
      saveSession(null);
    } catch {
      try { sessionStorage.removeItem("egmon-hub"); } catch { /* ignore */ }
      show("screen-modes");
      return;
    }
  }
  openAuth();
}

function bind() {
  const rail = $("reactions");
  if (rail) {
    rail.innerHTML = `<span class="reactions-label">Réactions</span>${REACTIONS.map((emoji) => `<button type="button" data-react="${emoji}" aria-label="Réagir">${emoji}</button>`).join("")}`;
    rail.addEventListener("click", (event) => {
      const button = event.target.closest("[data-react]");
      if (button) sendReaction(button.dataset.react, button);
    });
  }
  $("app-dialog").addEventListener("click", (event) => {
    if (event.target === $("app-dialog")) $("app-dialog").hidden = true;
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (!$("rank-card").hidden) {
      $("rank-card").hidden = true;
      return;
    }
    if (!$("app-dialog").hidden) {
      $("app-dialog").hidden = true;
      return;
    }
    if ($("game-overlay").dataset.dismiss === "1") hideOverlay();
  });
  $("game-overlay").addEventListener("click", (event) => {
    if (event.target === $("game-overlay") && $("game-overlay").dataset.dismiss === "1") hideOverlay();
  });
  document.body.addEventListener("click", (event) => {
    if (!$("game-menu").hidden && !event.target.closest(".game-tools")) closeGameMenu();
    const groupBtn = event.target.closest("[data-field] [data-value]");
    if (groupBtn) {
      const field = groupBtn.closest("[data-field]");
      field.querySelectorAll("[data-value]").forEach((btn) => btn.setAttribute("aria-pressed", "false"));
      groupBtn.setAttribute("aria-pressed", "true");
      if (field.dataset.field === "timeMode" && groupBtn.dataset.value === "global" && Number($("timeLimit").value) < 60) {
        $("timeLimit").value = 300;
      }
      if (field.dataset.field === "p1Color" || field.dataset.field === "p2Color") {
        syncPenColors(field.dataset.field);
      }
      if (field.dataset.field === "theme") {
        app.prefs.theme = groupBtn.dataset.value;
        savePrefs(app.prefs);
      }
      if (document.getElementById("setup-form") && ! $("screen-setup").hidden) syncFormBits();
      else if (field.dataset.field === "theme" && !$("screen-game").hidden) applyTheme(app.prefs.theme);
    }
    const preset = event.target.closest("[data-set-time]");
    if (preset) {
      $("timeLimit").value = preset.dataset.setTime;
      markTimePreset();
    }
    const tableBtn = event.target.closest("[data-table]");
    if (tableBtn && app.seat === 0 && !app.game) {
      const value = tableBtn.dataset.value;
      const patch = tableBtn.dataset.table === "time"
        ? (value === "none" ? { timeMode: "none" } : { timeMode: "global", timeLimit: Number(value) })
        : { scoreLimit: Number(value) };
      app.socket?.emit("table", patch);
    }
    const hubBtn = event.target.closest("[data-open-hub]");
    if (hubBtn) openHub(hubBtn.dataset.openHub);
    if (event.target.closest("#modes-back")) {
      if ($("mode-home")?.hidden) openHub("");
      else if (history.state?.page && history.state.page !== "home") history.back();
      else goHome();
    }
    if (event.target.closest("[data-soon]")) soon();
    if (event.target.closest("[data-home]")) {
      if (history.state?.page && history.state.page !== "home") history.back();
      else goHome();
    }
  });

  for (const id of ["rows", "cols", "scoreLimit"]) {
    $(id).addEventListener("input", () => {
      if (!$("screen-setup") || $("screen-setup").hidden) return;
      syncFormBits();
    });
  }

  $("create-match").addEventListener("click", () => {
    beginPlay();
  });
  $("go-solo").addEventListener("click", () => {
    askDialog({
      kicker: "Confirmer",
      title: "Robot",
      text: "Tu joues contre un robot. Tu confirmes ce choix ?",
      confirm: "Oui",
      cancel: "Retour",
      onYes: () => openSetup("solo"),
    });
  });
  $("go-local").addEventListener("click", () => {
    askDialog({
      kicker: "Confirmer",
      title: "Multijoueurs",
      text: "Vous jouez à deux sur cet écran. Vous confirmez ?",
      confirm: "Oui",
      cancel: "Retour",
      onYes: () => openSetup("local"),
    });
  });
  $("go-online").addEventListener("click", () => show("screen-online"));
  $("go-find").addEventListener("click", () => show("screen-find"));
  $("go-account").addEventListener("click", openProfile);
  $("go-progress").addEventListener("click", openProgress);
  $("go-badges").addEventListener("click", openBadges);
  $("go-rank").addEventListener("click", () => show("screen-rank"));
  const openRankCard = (event) => {
    const host = event.target.closest("[data-player]");
    if (host?.dataset.player) showPlayerCard(host.dataset.player);
  };
  $("rank-top").addEventListener("click", openRankCard);
  $("rank-list").addEventListener("click", openRankCard);
  $("rank-card").addEventListener("click", (event) => {
    if (event.target === $("rank-card")) $("rank-card").hidden = true;
  });
  $("rank-card-close").addEventListener("click", () => { $("rank-card").hidden = true; });
  $("rank-general").addEventListener("click", () => selectRank("general"));
  $("rank-online").addEventListener("click", () => selectRank("online"));
  $("rank-me").addEventListener("click", scrollToMyRank);
  $("rank-search").addEventListener("input", paintBoard);
  $("go-history").addEventListener("click", () => {
    renderHistory();
    show("screen-history");
  });
  $("go-admin").addEventListener("click", () => show("screen-admin"));
  $("profile-file").addEventListener("change", (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) uploadProfilePhoto(file);
  });
  $("profile-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = $("profile-name").value.trim();
    const email = $("profile-email").value.trim();
    if (!name || !email) {
      toast("Écris un nom et un e-mail.");
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      toast("Cet e-mail n’est pas valide.");
      return;
    }
    const photo = $("profile-photo").dataset.full || "";
    try {
      const response = await fetch(`/api/profile/${playerId()}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, photo }),
      });
      const data = await response.json().catch(() => ({}));
      if (response.status === 401) {
        saveSession(null);
        paintUserChip();
        toast("Entre à nouveau avec Commencez.");
        return;
      }
      if (!response.ok) {
        toast(data.error || "Profil non enregistré.");
        return;
      }
      saveProfile({ name: data.name || name, email: data.email || email, photo: data.photo || photo, icon: data.icon });
      noteAdmin(data);
      announcePresence();
      const session = loadSession();
      if (session?.connected) saveSession({ ...session, email: data.email || email });
      paintUserChip();
      const password = $("profile-password").value;
      const confirm = $("profile-confirm").value;
      if (password || confirm) {
        if (password.length < 6 || password !== confirm) {
          toast("Le mot de passe doit avoir au moins 6 caractères, deux fois le même.");
          return;
        }
        const changed = await sendJson("/api/auth/password", "POST", { password, confirm });
        if (!changed?.ok) {
          toast("Le mot de passe n'a pas pu être changé.");
          return;
        }
        $("profile-password").value = "";
        $("profile-confirm").value = "";
      }
      toast("Profil enregistré.");
    } catch {
      toast("Profil non enregistré.");
    }
  });
  $("setup-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const { settings, opponent } = readSettingsFromForm();
    const needSecond = app.formMode === "local" || opponent === "local";
    if (!$("p1Name").value.trim()) $("p1Name").value = (loadProfile().name || "").trim();
    const missing = !$("p1Name").value.trim() ? $("p1Name") : needSecond && !$("p2Name").value.trim() ? $("p2Name") : null;
    if (missing) {
      toast("Écris le nom des joueurs pour cette partie.");
      missing.focus();
      return;
    }
    if (app.formMode === "online") {
      remember(settings);
      createOnlineRoom(settings);
      return;
    }
    const mode = app.formMode === "custom" ? opponent : app.formMode;
    startMatch(settings, mode === "local" ? "local" : "solo");
  });
  $("create-open").addEventListener("click", () => openSetup("online"));
  $("join-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const code = $("join-code").value.trim().toUpperCase();
    if (!/^EGD-[A-Z2-9]{6}$/.test(code)) {
      toast("Le code ressemble à EGD-K7MQ2P.");
      return;
    }
    joinRoom(code, app.prefs.p2Color);
  });
  $("copy-code").addEventListener("click", () => copyText(app.roomCode || $("lobby-code").textContent));
  $("copy-link").addEventListener("click", copyRoomLink);
  $("lobby-cancel").addEventListener("click", () => confirmLeave(() => {
    allowLeave = true;
    leaveOnlineScreen();
  }, true));
  $("lobby-present").addEventListener("click", () => sendInRoom("present"));
  $("lobby-launch").addEventListener("click", () => sendInRoom("launch"));
  $("chat-open").addEventListener("click", () => toggleChat());
  $("chat-close").addEventListener("click", () => toggleChat(false));
  $("chat-mate").addEventListener("click", () => openSeatCard(otherSeat()));
  for (const card of document.querySelectorAll(".player")) {
    card.addEventListener("click", () => openSeatCard(card.id === "p1-card" ? 1 : 0));
  }
  $("chat-form").addEventListener("submit", sendChat);
  $("chat-input")?.addEventListener("input", fitChatInput);
  $("chat-input")?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    sendChat(event);
  });
  $("chat-voice").addEventListener("click", () => { toggleVoice(); });
  $("voice-done").addEventListener("click", () => { toggleVoice(); });
  $("voice-cancel").addEventListener("click", cancelVoice);
  $("voice-hear").addEventListener("click", hearVoiceDraft);
  $("voice-send").addEventListener("click", sendVoiceDraft);
  $("find-back").addEventListener("click", () => {
    if (history.state?.page === "find") history.back();
    else show("screen-modes", "replace");
  });
  $("challenge-list").addEventListener("click", (event) => {
    const card = event.target.closest("[data-challenge]");
    if (!card) return;
    startChallenge(card.dataset.challenge);
  });
  $("find-list").addEventListener("click", (event) => {
    const card = event.target.closest("[data-token]");
    if (!card) return;
    if (card.dataset.busy === "1") {
      toast("Cette personne est occupée.");
      return;
    }
    app.socket?.emit("invite", { token: card.dataset.token });
    toast("Invitation envoyée.");
  });
  $("game-menu-btn").addEventListener("click", () => {
    const menu = $("game-menu");
    menu.hidden = !menu.hidden;
    $("game-menu-btn").setAttribute("aria-expanded", menu.hidden ? "false" : "true");
  });
  $("pause-btn").addEventListener("click", () => {
    closeGameMenu();
    if (app.game?.status === "playing") showPause();
  });
  $("abandon-btn").addEventListener("click", () => {
    closeGameMenu();
    if (app.game?.status === "playing") confirmAbandon();
  });
  $("restart-btn").addEventListener("click", () => {
    closeGameMenu();
    if (app.mode === "online") {
      toast("Recommencer n’est pas disponible en ligne.");
      return;
    }
    if (app.game) rematch();
  });
  $("brand").addEventListener("click", () => {
    if (document.body.dataset.page === "play") return;
    goHome();
  });
  app.board = new BoardView($("board"));
  bindSheetZoom();
  app.board.canPlay = () => canPlay();
  app.board.onMove = (move) => tryMove(move);
  app.board.onTrace = (loop, fault) => {
    app.tracing = false;
    app.board.setTracing(false);
    if (!app.game || app.game.status !== "playing") return;
    if (fault) {
      app.traceFaults = (app.traceFaults || 0) + 1;
      toast("Le trait dépasse une case.");
      syncTrace();
      return;
    }
    if (!loop) {
      toast("Glisse jusqu'à toucher le trait.");
      syncTrace();
      return;
    }
    const result = closeByHand(app.game, loop);
    if (!result.ok) {
      toast(result.reason);
      syncTrace();
      return;
    }
    app.handCloses = (app.handCloses || 0) + 1;
    app.sounds.box();
    popScore(result.player);
    if (result.eaten) popScore(1 - result.player);
    reactToMove(result, false);
    refreshHud();
    saveMatch();
    app.inputLock = true;
    window.setTimeout(() => afterMove(), 280);
  };
  new ResizeObserver(() => app.board.resize()).observe($("board").parentElement);

  const params = new URLSearchParams(location.search);
  const room = validRoomCode(params.get("room"));
  const sameRoom = room && readRoomSnap()?.code === room;
  const resumed = (!room || sameRoom) && resumeSavedRoom();
  if (room && !sameRoom) claimRoomLink(room);
  const kept = !resumed && !room && restoreMatch();

  const opened = (location.hash || "#home").slice(1);
  const first = resumed
    ? (readRoomSnap()?.playing ? "game" : "lobby")
    : kept
      ? "game"
      : (SCREEN_BY_PAGE[opened] ? opened : "home");
  history.replaceState(
    { page: first, ...(first === "lobby" || (first === "game" && resumed) ? { flow: "online" } : {}) },
    "",
    first === "home" ? `${location.pathname}${location.search}` : `${location.pathname}${location.search}#${first}`,
  );
  if (!resumed && !room && !kept) {
    if (first === "history") renderHistory();
    if (first === "game") {
      if (!restoreMatch()) show("screen-home", "replace");
    } else if (first === "setup") {
      openSetup(sessionStorage.getItem("egmon-setup-mode") || "solo", "skip");
    } else if (first === "lobby") {
      show("screen-modes", "replace");
    } else if (first !== "home") {
      show(SCREEN_BY_PAGE[first], "skip");
    }
  }
  window.addEventListener("beforeunload", (event) => {
    if (!inLiveMatch()) return;
    event.preventDefault();
    event.returnValue = "";
  });
  const viewport = window.visualViewport;
  if (viewport) {
    const placeKeyboard = () => {
      const keyboard = Math.max(0, Math.round(window.innerHeight - viewport.height - viewport.offsetTop));
      document.documentElement.style.setProperty("--keyboard", `${keyboard}px`);
      document.body.classList.toggle("keyboard", keyboard > 80);
      if (keyboard > 80) window.scrollTo(0, 0);
    };
    viewport.addEventListener("resize", placeKeyboard);
    viewport.addEventListener("scroll", placeKeyboard);
    placeKeyboard();
  }
  $("chat-input")?.addEventListener("focus", () => {
    requestAnimationFrame(() => window.scrollTo(0, 0));
  });
  window.addEventListener("popstate", (event) => {
    const surface = holdSurface();
    if (surface && !allowLeave) {
      history.pushState(
        { page: surface, ...(app.mode === "online" ? { flow: "online" } : {}) },
        "",
        `${location.pathname}${location.search}#${surface}`,
      );
      show(surface === "lobby" ? "screen-lobby" : "screen-game", "skip");
      if ($("app-dialog").hidden) {
        confirmLeave(() => {
          allowLeave = true;
          if (surface === "lobby") leaveOnlineScreen();
          else goHome();
        }, surface === "lobby");
      }
      return;
    }
    if (allowLeave) allowLeave = false;
    const page = event.state?.page || "home";
    if (page !== "lobby" && page !== "game" && (app.mode === "online" || sessionStorage.getItem("egmon-room"))) {
      dropOnlineRoom();
    }
    if ((page === "lobby" || (page === "game" && event.state?.flow === "online")) && !sessionStorage.getItem("egmon-room")) {
      show("screen-modes", "replace");
      return;
    }
    if (page === "history") renderHistory();
    if (page === "lobby" && readRoomSnap() && !readRoomSnap().playing) {
      resumeSavedRoom();
      return;
    }
    if (page === "game") {
      if (restoreMatch()) return;
      if (readRoomSnap()?.playing) {
        resumeSavedRoom();
        return;
      }
      show("screen-home", "replace");
      return;
    }
    if (page === "setup") {
      openSetup(sessionStorage.getItem("egmon-setup-mode") || "solo", "skip");
      return;
    }
    show(SCREEN_BY_PAGE[page] || "screen-home", "skip");
  });

  applyTheme($("screen-game").hidden ? "classic" : app.prefs.theme);
  app.sounds.enabled = false;
  $("auth-form").addEventListener("submit", submitAuth);
  $("auth-known").addEventListener("click", alreadyAccount);
  $("auth-back").addEventListener("click", leaveAuth);
  $("auth-forgot").addEventListener("click", forgotPassword);
  $("auth-help").addEventListener("click", authHelp);
  document.querySelectorAll(".secret-see").forEach((button) => {
    button.addEventListener("click", () => {
      const input = $(button.dataset.for);
      if (!input) return;
      const shown = input.type === "password";
      input.type = shown ? "text" : "password";
      button.classList.toggle("is-on", shown);
      button.setAttribute("aria-pressed", shown ? "true" : "false");
      button.setAttribute("aria-label", shown ? "Masquer le mot de passe" : "Afficher le mot de passe");
    });
  });
  restoreAccount();
  connectSocket().then(() => announcePresence()).catch(() => {});
  window.addEventListener("pagehide", () => saveMatch());
  requestAnimationFrame(loop);
  window.egmonApp = app;
}

bind();
