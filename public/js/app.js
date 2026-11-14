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
  normalizeSettings,
  sheetHouseCap,
  tick,
  COLORS,
} from "./engine.js";
import { BoardView, displayColor } from "./render.js";
import {
  clearHistory,
  loadHistory,
  loadPrefs,
  loadProfile,
  playerId,
  pushHistory,
  replaceHistory,
  savePrefs,
  saveProfile,
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
  ignoreOnline: false,
  starterFlip: 0,
  lastTs: 0,
  clockSync: null,
  socket: null,
  roomCode: null,
  sounds: new Sounds(),
  board: null,
};

const $ = (id) => document.getElementById(id);

const SCREEN_BY_PAGE = {
  home: "screen-home",
  modes: "screen-modes",
  setup: "screen-setup",
  online: "screen-online",
  lobby: "screen-lobby",
  game: "screen-game",
  history: "screen-history",
  profile: "screen-profile",
};

const SHELL_PAGES = new Set(["home", "modes", "setup", "profile", "history"]);

function pageOf(id) {
  return Object.keys(SCREEN_BY_PAGE).find((key) => SCREEN_BY_PAGE[key] === id) || "home";
}

function show(id, historyMode = "push") {
  document.querySelectorAll(".screen").forEach((screen) => {
    screen.hidden = screen.id !== id;
  });
  const page = pageOf(id);
  document.body.dataset.page = SHELL_PAGES.has(page) ? page : "play";
  if (id === "screen-game") {
    const wrap = document.querySelector(".board-wrap");
    if (app.game && wrap) {
      wrap.style.setProperty("--sheet-w", String(app.game.cols));
      wrap.style.setProperty("--sheet-h", String(app.game.rows));
    }
    requestAnimationFrame(() => app.board.resize());
  }
  if (id === "screen-profile") {
    const profile = loadProfile();
    $("profile-name").value = profile.name;
    $("profile-email").value = profile.email;
    pullProfile();
  }
  if (id === "screen-history") pullHistory();
  if (historyMode === "skip") return;
  const url = page === "home"
    ? `${location.pathname}${location.search}`
    : `${location.pathname}${location.search}#${page}`;
  if (historyMode === "replace" || history.state?.page === page) history.replaceState({ page }, "", url);
  else history.pushState({ page }, "", url);
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
  setGroup("p1Color", prefs.p1Color);
  setGroup("p2Color", prefs.p2Color);
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

function syncFormBits() {
  $("custom-size").hidden = readGroup("size") !== "custom";
  const timeMode = readGroup("timeMode");
  $("time-box").hidden = timeMode === "none";
  $("score-custom").hidden = readGroup("score") !== "custom";
  syncScoreCap();
  document.querySelectorAll("[data-show]").forEach((el) => {
    el.hidden = !el.dataset.show.split(" ").includes(app.formMode);
  });
  const titles = {
    solo: ["Partie solo", "Réglez la feuille, puis affrontez un robot."],
    local: ["Deux joueurs", "Même écran, deux stylos."],
    online: ["Créer une salle", "Votre ami vous rejoindra avec le code."],
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
  applyTheme(readGroup("theme") || app.prefs.theme);
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
  $("p1Name").value = "";
  $("p2Name").value = "";
  show("screen-setup", historyMode);
}

function openProfile() {
  show("screen-profile");
}

function remember(settings) {
  const { p1Name, p2Name, ...rest } = settings;
  app.prefs = { ...app.prefs, ...rest };
  savePrefs(app.prefs);
  applyTheme(app.prefs.theme);
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
  show("screen-game");
  paintMatch();
  showModeReminder();
  if (mode === "solo" && app.game.current === 1) queueAi();
  saveMatch();
}

function showModeReminder() {
  app.tracing = false;
  app.board?.setTracing(false);
  const hand = app.game?.settings?.closeMode === "hand";
  showOverlay({
    kicker: hand ? "Dessiner seul" : "Le système",
    title: hand ? "Tu dessines" : "Le système ferme",
    text: hand
      ? "Quand une maison est prête, glisse sur tes points pour la fermer."
      : "Les maisons se ferment toutes seules.",
    actions: [{ label: "Compris", primary: true, on: hideOverlay }],
  });
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

function resetSheetZoom() {
  const stage = document.querySelector(".board-stage");
  const wrap = document.querySelector(".board-wrap");
  sheetZoom.value = 1;
  wrap?.style.setProperty("--sheet-zoom", "1");
  if (stage) {
    stage.scrollLeft = 0;
    stage.scrollTop = 0;
  }
  app.board?.resize();
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
  app.players.forEach((player, index) => {
    const card = $(`p${index}-card`);
    card.style.setProperty("--pen", displayColor(player.color, app.prefs.theme));
    $(`p${index}-name`).textContent = player.name;
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
    const houseRule = "1 point par maison. Encercler l’autre prend son point, et l’intérieur est fermé.";
    chip.textContent = game.settings.extraTurn
      ? `${houseRule} Si tu encercles, tu rejoues.`
      : `${houseRule} Un point par tour.`;
    chip.classList.remove("attach");
  }
  $("pause-btn").hidden = app.mode === "online";
  const name = app.players[game.current]?.name || "";
  const mine = app.mode !== "local" && game.current === (app.mode === "online" ? app.seat : 0);
  $("turn-label").textContent = game.status !== "playing"
    ? "Partie terminée"
    : mine
      ? "À vous de jouer"
      : `Au tour de ${name}`;
  updateTimers();
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
}

function hideOverlay() {
  const overlay = $("game-overlay");
  overlay.hidden = true;
  overlay.classList.remove("celebrate");
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
    button.addEventListener("click", action.on);
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
  if (!app.game || app.game.status !== "playing" || app.paused || app.inputLock) return false;
  if (app.mode === "online") return app.seat === app.game.current;
  if (app.mode === "solo") return app.players[app.game.current]?.kind === "human";
  return true;
}

function tryMove(move) {
  if (!canPlay()) return;
  if (app.mode === "online") {
    app.inputLock = true;
    app.socket.emit("move", move, (res) => {
      if (!res?.ok) {
        app.inputLock = false;
        if (res?.error) toast(res.error);
      }
    });
    return;
  }
  playLocal(move, false);
}

function playLocal(move, fromTimeout) {
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
    const move = chooseMove(app.game, app.prefs.difficulty);
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
    if (!$("screen-profile").hidden) {
      $("profile-name").value = profile.name;
      $("profile-email").value = profile.email || "";
    }
  } catch {
    /* le profil reste dans le navigateur */
  }
}

function syncGame(entry) {
  sendJson(`/api/games/${playerId()}`, "POST", entry).catch(() => {});
}

async function pullHistory() {
  try {
    const games = await sendJson(`/api/games/${playerId()}`, "GET");
    if (!Array.isArray(games)) return;
    if (!games.length) {
      loadHistory().forEach((entry) => syncGame(entry));
      return;
    }
    replaceHistory(games);
    if (!$("screen-history").hidden) renderHistory();
  } catch {
    /* l'historique reste dans le navigateur */
  }
}

function recordGame() {
  if (app.recorded || !app.game) return;
  app.recorded = true;
  const game = app.game;
  const userSeat = app.mode === "local" ? null : app.mode === "online" ? app.seat : 0;
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
    difficulty: app.mode === "solo" ? app.prefs.difficulty : null,
  };
  pushHistory(entry);
  syncGame(entry);
  if (game.winner === "draw") app.sounds.tap();
  else if (userSeat == null || game.winner === userSeat) app.sounds.win();
  else app.sounds.lose();
}

function resultCopy() {
  const game = app.game;
  let title = "Égalité";
  if (game.winner === 0 || game.winner === 1) {
    if (app.mode === "local") title = `${app.players[game.winner].name} gagne`;
    else title = game.winner === (app.mode === "online" ? app.seat : 0) ? "Victoire" : "Défaite";
  }
  let because = REASON[game.reason] || "";
  if (game.reason === "board" && game.settings.scoreLimit > 0) {
    because = "La feuille est pleine avant l’objectif. Le plus grand score gagne.";
  }
  const text = `${app.players[0].name} ${game.scores[0]}  ·  ${game.scores[1]} ${app.players[1].name}\n${because}`;
  return { title, text, celebrate: title === "Victoire" || (app.mode === "local" && title !== "Égalité") };
}

function showResult() {
  const { title, text, celebrate } = resultCopy();
  showOverlay({
    kicker: "Partie terminée",
    title,
    text,
    celebrate,
    note: true,
    actions: [
      { label: "Revanche", primary: true, on: () => rematch() },
      { label: "Accueil", on: () => goHome() },
    ],
  });
}

function endLocal() {
  recordGame();
  showResult();
}

function rematch() {
  if (app.mode === "online") {
    app.socket.emit("rematch");
    toast("Revanche proposée.");
    return;
  }
  app.starterFlip = app.starterFlip === 0 ? 1 : 0;
  app.game = createGame(app.prefs, app.starterFlip);
  app.paused = false;
  app.inputLock = false;
  app.recorded = false;
  app.timeoutQueued = null;
  app.board.clearAnims();
  paintMatch();
  showModeReminder();
  if (app.mode === "solo" && app.game.current === 1) queueAi();
  saveMatch();
}

function goHome() {
  try { sessionStorage.removeItem(MATCH_KEY); } catch { /* ignore */ }
  if (app.mode === "online" && app.game?.status === "playing") {
    app.game.winner = 1 - app.seat;
    app.game.reason = "abandon";
    app.game.status = "finished";
    recordGame();
  }
  app.ignoreOnline = true;
  if (app.mode === "online") app.socket?.emit("leave");
  app.game = null;
  app.paused = false;
  app.mode = null;
  hideOverlay();
  show("screen-home");
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
      { label: "Accueil", on: () => goHome() },
    ],
  });
}

function loop(ts) {
  if (!app.lastTs) app.lastTs = ts;
  const dt = Math.min(80, ts - app.lastTs);
  app.lastTs = ts;
  if (app.game && app.mode !== "online" && !app.paused && app.game.status === "playing") {
    const clock = tick(app.game, dt);
    if (clock.timedOut && clock.kind === "turn") onTurnTimeout();
    if (clock.timedOut && clock.kind === "global") endLocal();
  }
  app.board?.frame(ts);
  if (app.game && !$("screen-game").hidden) updateTimers();
  requestAnimationFrame(loop);
}

function ensureSocket() {
  if (!window.io) return null;
  if (app.socket) return app.socket;
  app.socket = window.io({ autoConnect: false });
  app.socket.on("connect_error", () => toast("Serveur injoignable. Lancez npm start."));
  app.socket.on("state", (msg) => onOnlineState(msg));
  app.socket.on("disconnect", () => {
    if (app.mode === "online") toast("Connexion interrompue.");
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

function connectSocket() {
  return loadSocketScript().then(() => {
  const socket = ensureSocket();
  if (!socket) return Promise.reject(new Error("offline"));
  if (socket.connected) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), 4000);
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once("connect_error", () => {
      clearTimeout(timer);
      reject(new Error("offline"));
    });
    socket.connect();
  });
  });
}

function onOnlineState(msg) {
  if (app.ignoreOnline) return;
  app.mode = "online";
  app.roomCode = msg.code;
  app.seat = msg.you;
  sessionStorage.setItem("egmon-room", JSON.stringify({ code: msg.code, playerId: playerId() }));
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
    theme: app.prefs.theme,
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
  const foe = app.players[1 - app.seat];
  const banner = $("conn-banner");
  if (msg.game && foe && foe.connected === false) {
    banner.hidden = false;
    banner.textContent = "Adversaire déconnecté. La partie lui sera perdue après une minute.";
  } else {
    banner.hidden = true;
  }
  if (!msg.game) {
    $("lobby-code").textContent = msg.code;
    $("lobby-status").textContent = "En attente d’un adversaire…";
    show("screen-lobby");
    return;
  }
  const event = msg.event || {};
  if (event.type === "rematch" || event.type === "start") {
    app.board.clearAnims();
    app.recorded = false;
    app.inputLock = false;
    app.paused = false;
    hideOverlay();
    resetSheetZoom();
  }
  show("screen-game");
  paintMatch();
  if (event.type === "move" || event.type === "timeout") {
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
    return;
  }
  if (event.type === "rematch-wait") {
    toast(msg.rematch?.[app.seat] ? "En attente de l’adversaire." : "Votre adversaire propose une revanche.");
  }
  if (app.game.status === "finished") finishOnline();
}

function finishOnline() {
  recordGame();
  showResult();
}

async function createRoom() {
  const { settings } = readSettingsFromForm();
  remember(settings);
  app.ignoreOnline = false;
  try {
    await connectSocket();
  } catch {
    toast("Le mode en ligne a besoin du serveur : npm start.");
    return;
  }
  app.socket.emit("create", { playerId: playerId(), name: settings.p1Name, settings }, (res) => {
    if (!res?.ok) toast(res?.error || "Impossible de créer la salle.");
  });
}

async function joinRoom(code, color) {
  app.ignoreOnline = false;
  try {
    await connectSocket();
  } catch {
    toast("Le mode en ligne a besoin du serveur : npm start.");
    return;
  }
  app.socket.emit("join", {
    playerId: playerId(),
    name: $("join-name").value,
    code,
    color,
  }, (res) => {
    if (!res?.ok) toast(res?.error || "Impossible de rejoindre.");
  });
}

function renderHistory() {
  const history = loadHistory();
  const ranked = history.filter((item) => item.userSeat === 0 || item.userSeat === 1);
  $("stat-played").textContent = String(history.length);
  $("stat-wins").textContent = String(ranked.filter((item) => item.winner === item.userSeat).length);
  $("stat-losses").textContent = String(ranked.filter((item) => item.winner !== "draw" && item.winner !== item.userSeat).length);
  $("stat-draws").textContent = String(ranked.filter((item) => item.winner === "draw").length);
  const list = $("history-list");
  if (!history.length) {
    list.innerHTML = `<p class="empty">Aucune partie enregistrée. Le papier est encore vierge.</p>`;
    return;
  }
  const modeLabel = { solo: "Solo", local: "2 joueurs", online: "En ligne" };
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
    return `<article class="history-item"><div><strong>${result}</strong><span>${esc(item.size)} · ${modeLabel[item.mode] || ""}${esc(diff)}</span></div><div><b>${left} – ${right}</b><span>${esc(when)}</span></div></article>`;
  }).join("");
}

function copyText(text) {
  navigator.clipboard?.writeText(text).then(() => toast("Copié.")).catch(() => toast(text));
}

function soon() {
  toast("Bientôt disponible.");
}

function bind() {
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
      else if (field.dataset.field === "theme") applyTheme(app.prefs.theme);
    }
    const preset = event.target.closest("[data-set-time]");
    if (preset) $("timeLimit").value = preset.dataset.setTime;
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
    const profile = loadProfile();
    const next = () => askDialog({
      kicker: "Avant de jouer",
      title: "Configure bien les paramètres",
      text: "Regarde la feuille, le score, le temps et la façon d'encercler avant de lancer.",
      confirm: "Continuer",
      cancel: "Retour",
      onYes: () => show("screen-modes"),
    });
    if (profile.name) {
      next();
      return;
    }
    askDialog({
      kicker: "Profil",
      title: "Votre nom de profil",
      text: "Ce nom est le tien. Il est gardé pour tes prochaines parties.",
      confirm: "Continuer",
      cancel: "Retour",
      field: { value: "", placeholder: "Ton nom" },
      onYes: (name) => {
        const saved = saveProfile({ name, email: profile.email });
        syncProfile(saved);
        next();
      },
    });
  });
  $("go-solo").addEventListener("click", () => {
    askDialog({
      kicker: "Confirmer",
      title: "Partie solo",
      text: "Tu joues contre un robot. Tu confirmes ce choix ?",
      confirm: "Oui",
      cancel: "Retour",
      onYes: () => openSetup("solo"),
    });
  });
  $("go-local").addEventListener("click", () => {
    askDialog({
      kicker: "Confirmer",
      title: "Deux joueurs",
      text: "Vous jouez à deux sur cet écran. Vous confirmez ?",
      confirm: "Oui",
      cancel: "Retour",
      onYes: () => openSetup("local"),
    });
  });
  $("go-online").addEventListener("click", soon);
  $("go-tourney").addEventListener("click", soon);
  $("go-profile").addEventListener("click", openProfile);
  $("go-history").addEventListener("click", () => {
    renderHistory();
    show("screen-history");
  });
  $("profile-form").addEventListener("submit", (event) => {
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
    saveProfile({ name, email });
    syncProfile({ name, email });
    toast("Profil enregistré.");
  });
  $("setup-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const { settings, opponent } = readSettingsFromForm();
    const needSecond = app.formMode === "local" || opponent === "local";
    const missing = !$("p1Name").value.trim() ? $("p1Name") : needSecond && !$("p2Name").value.trim() ? $("p2Name") : null;
    if (missing) {
      toast("Écris le nom des joueurs pour cette partie.");
      missing.focus();
      return;
    }
    if (app.formMode === "online") {
      createRoom();
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
    joinRoom(code, readGroup("joinColor"));
  });
  $("copy-code").addEventListener("click", () => copyText(app.roomCode || $("lobby-code").textContent));
  $("copy-link").addEventListener("click", () => {
    const url = new URL(location.href);
    url.searchParams.set("room", app.roomCode || "");
    copyText(url.toString());
  });
  $("lobby-cancel").addEventListener("click", () => {
    app.ignoreOnline = true;
    app.socket?.emit("leave");
    sessionStorage.removeItem("egmon-room");
    app.mode = null;
    show("screen-home");
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
      toast("En ligne, la revanche se propose en fin de partie.");
      return;
    }
    if (app.game) rematch();
  });
  $("clear-history").addEventListener("click", () => {
    clearHistory();
    sendJson(`/api/games/${playerId()}`, "DELETE").catch(() => {});
    renderHistory();
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
    app.sounds.box();
    popScore(result.player);
    if (result.eaten) popScore(1 - result.player);
    refreshHud();
    saveMatch();
    app.inputLock = true;
    window.setTimeout(() => afterMove(), 280);
  };
  new ResizeObserver(() => app.board.resize()).observe($("board").parentElement);

  const params = new URLSearchParams(location.search);
  const room = params.get("room");
  if (room) {
    $("join-code").value = room.toUpperCase();
    $("online-lead").textContent = "Une invitation est prête. Choisissez votre stylo, puis entrez.";
    show("screen-online");
  } else {
    const saved = sessionStorage.getItem("egmon-room");
    if (saved) {
      try {
        const { code } = JSON.parse(saved);
        app.ignoreOnline = false;
        connectSocket().then(() => {
          app.socket.emit("rejoin", { playerId: playerId(), code }, (res) => {
            if (!res?.ok) sessionStorage.removeItem("egmon-room");
          });
        }).catch(() => {});
      } catch {
        sessionStorage.removeItem("egmon-room");
      }
    }
  }

  const opened = (location.hash || "#home").slice(1);
  const first = SCREEN_BY_PAGE[opened] ? opened : "home";
  history.replaceState(
    { page: first },
    "",
    first === "home" ? `${location.pathname}${location.search}` : `${location.pathname}${location.search}#${first}`,
  );
  if (first === "history") renderHistory();
  if (first === "game") {
    if (!restoreMatch()) show("screen-home", "replace");
  } else if (first === "setup") {
    openSetup(sessionStorage.getItem("egmon-setup-mode") || "solo", "skip");
  } else if (first !== "home") {
    show(SCREEN_BY_PAGE[first], "skip");
  }
  window.addEventListener("popstate", (event) => {
    const page = event.state?.page || "home";
    if (page === "history") renderHistory();
    if (page === "game") {
      if (!restoreMatch()) show("screen-home", "replace");
      return;
    }
    if (page === "setup") {
      openSetup(sessionStorage.getItem("egmon-setup-mode") || "solo", "skip");
      return;
    }
    show(SCREEN_BY_PAGE[page] || "screen-home", "skip");
  });

  applyTheme(app.prefs.theme);
  app.sounds.enabled = false;
  requestAnimationFrame(loop);
  window.egmonApp = app;
}

bind();
