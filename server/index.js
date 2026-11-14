import express from "express";
import { createServer } from "http";
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
} from "../public/js/engine.js";
import {
  clearGames,
  dbReady,
  initDb,
  insertGame,
  insertMessage,
  isUuid,
  listGames,
  readProfile,
  upsertProfile,
} from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  maxHttpBufferSize: 16_000,
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
const hits = new Map();
const connections = new Map();
const ROOM_LIMIT = 80;

app.disable("x-powered-by");
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Content-Security-Policy", [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self'",
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
  if (limited(`${req.ip}:api`, 40, 60_000)) {
    res.status(429).json({ error: "Trop d'essais." });
    return "";
  }
  return id;
}

app.get("/api/profile/:id", api(async (req, res) => {
  const id = apiPlayer(req, res);
  if (!id) return;
  const profile = await readProfile(id);
  res.json(profile || { name: "", email: "" });
}));

app.put("/api/profile/:id", api(async (req, res) => {
  const id = apiPlayer(req, res);
  if (!id) return;
  const name = String(req.body?.name || "").trim().slice(0, 40);
  const email = String(req.body?.email || "").trim().slice(0, 80);
  if (!name || (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
    res.status(400).json({ error: "Nom ou e-mail invalide." });
    return;
  }
  res.json(await upsertProfile({ id, name, email }));
}));

app.get("/api/games/:id", api(async (req, res) => {
  const id = apiPlayer(req, res);
  if (!id) return;
  res.json(await listGames(id));
}));

app.post("/api/games/:id", api(async (req, res) => {
  const id = apiPlayer(req, res);
  if (!id) return;
  const entry = req.body || {};
  if (!isUuid(entry.id) || !Array.isArray(entry.names) || !Array.isArray(entry.scores)) {
    res.status(400).json({ error: "Partie invalide." });
    return;
  }
  await insertGame(id, entry);
  res.json({ ok: true });
}));

app.post("/api/messages", api(async (req, res) => {
  if (!dbReady()) {
    res.status(503).json({ error: "Base indisponible." });
    return;
  }
  if (limited(`${req.ip}:message`, 6, 60 * 60 * 1000)) {
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

app.delete("/api/games/:id", api(async (req, res) => {
  const id = apiPlayer(req, res);
  if (!id) return;
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

io.use((socket, next) => {
  const ip = socket.handshake.address || "unknown";
  const count = connections.get(ip) || 0;
  if (count >= 12) return next(new Error("Trop de connexions."));
  connections.set(ip, count + 1);
  socket.on("disconnect", () => {
    const left = (connections.get(ip) || 1) - 1;
    if (left <= 0) connections.delete(ip);
    else connections.set(ip, left);
  });
  next();
});

function seatOf(room, playerId) {
  return room.players.findIndex((player) => player && player.id === playerId);
}

function snapshot(room, event = null) {
  return {
    code: room.code,
    settings: room.settings,
    game: room.game,
    seats: room.players.map((player) => (
      player
        ? { name: player.name, color: player.color, connected: player.connected, present: true }
        : { present: false, connected: false, name: "", color: "" }
    )),
    rematch: room.rematch.slice(),
    event,
  };
}

function emitState(room, event = null) {
  room.touched = Date.now();
  const base = snapshot(room, event);
  for (const seat of [0, 1]) {
    const player = room.players[seat];
    if (!player?.socketId) continue;
    io.to(player.socketId).emit("state", { ...base, you: seat });
  }
}

function clearForfeit(room, seat) {
  if (room.forfeit[seat]) {
    clearTimeout(room.forfeit[seat]);
    room.forfeit[seat] = null;
  }
}

io.on("connection", (socket) => {
  socket.on("create", (payload = {}, ack) => {
    if (rooms.size >= ROOM_LIMIT) return ack?.({ ok: false, error: "Le serveur est plein." });
    if (limited(`${socket.id}:create`, 4, 60_000)) return ack?.({ ok: false, error: "Trop de salles créées." });
    const settings = normalizeSettings({ ...payload.settings, p1Name: payload.name });
    const code = makeRoomCode(rooms);
    const room = {
      code,
      settings,
      game: null,
      players: [
        {
          id: safePlayerId(payload.playerId, socket.id),
          name: settings.p1Name,
          color: settings.p1Color,
          socketId: socket.id,
          connected: true,
        },
        null,
      ],
      rematch: [false, false],
      forfeit: [null, null],
      touched: Date.now(),
    };
    rooms.set(code, room);
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.playerId = room.players[0].id;
    ack?.({ ok: true, code });
    emitState(room, { type: "created" });
  });

  socket.on("join", (payload = {}, ack) => {
    if (limited(`${socket.id}:join`, 12, 60_000)) return ack?.({ ok: false, error: "Trop d'essais. Patiente un peu." });
    const code = roomCode(payload.code);
    const room = code ? rooms.get(code) : null;
    if (!room) return ack?.({ ok: false, error: "Salle introuvable." });
    const existing = seatOf(room, safePlayerId(payload.playerId, ""));
    if (existing >= 0) {
      attach(socket, room, existing, payload.playerId);
      ack?.({ ok: true, code });
      emitState(room, { type: "rejoin" });
      return;
    }
    if (room.players[1]) return ack?.({ ok: false, error: "Cette salle est complète." });
    const name = cleanName(payload.name, "Joueur 2");
    let color = payload.color;
    if (!["red", "blue", "black", "green", "purple", "orange"].includes(color) || color === room.settings.p1Color) {
      color = room.settings.p2Color === room.settings.p1Color ? "red" : room.settings.p2Color;
      if (color === room.settings.p1Color) {
        color = ["red", "blue", "black", "green", "purple", "orange"].find((item) => item !== room.settings.p1Color);
      }
    }
    room.settings = { ...room.settings, p2Name: name, p2Color: color };
    room.players[1] = { id: safePlayerId(payload.playerId, socket.id), name, color, socketId: socket.id, connected: true };
    room.game = createGame(room.settings, 0);
    attach(socket, room, 1, room.players[1].id);
    ack?.({ ok: true, code });
    emitState(room, { type: "start" });
  });

  socket.on("rejoin", (payload = {}, ack) => {
    if (limited(`${socket.id}:join`, 12, 60_000)) return ack?.({ ok: false });
    const code = roomCode(payload.code);
    const room = code ? rooms.get(code) : null;
    const seat = room ? seatOf(room, safePlayerId(payload.playerId, "")) : -1;
    if (!room || seat < 0) return ack?.({ ok: false });
    attach(socket, room, seat, payload.playerId);
    ack?.({ ok: true, code: room.code });
    emitState(room, { type: "rejoin" });
  });

  socket.on("move", (move, ack) => {
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
      room.rematch = [false, false];
      emitState(room, { type: "rematch" });
    } else {
      emitState(room, { type: "rematch-wait" });
    }
  });

  socket.on("leave", () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    const seat = seatOf(room, socket.data.playerId);
    if (seat === 0 && !room.players[1]) {
      rooms.delete(room.code);
      return;
    }
    if (seat >= 0 && room.game?.status === "playing") {
      abandon(room.game, seat);
      emitState(room, { type: "abandon" });
    }
  });

  socket.on("disconnect", () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    const seat = seatOf(room, socket.data.playerId);
    if (seat < 0 || room.players[seat].socketId !== socket.id) return;
    room.players[seat].connected = false;
    emitState(room, { type: "presence" });
    if (room.game?.status === "playing") {
      clearForfeit(room, seat);
      room.forfeit[seat] = setTimeout(() => {
        if (!room.players[seat]?.connected && room.game?.status === "playing") {
          abandon(room.game, seat);
          emitState(room, { type: "forfeit" });
        }
      }, 60000);
    }
  });
});

function attach(socket, room, seat, playerId) {
  clearForfeit(room, seat);
  const id = safePlayerId(playerId, room.players[seat].id);
  room.players[seat].socketId = socket.id;
  room.players[seat].connected = true;
  room.players[seat].id = id;
  socket.join(room.code);
  socket.data.roomCode = room.code;
  socket.data.playerId = id;
}

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const playing = room.game?.status === "playing" && room.players[0]?.connected && room.players[1]?.connected;
    if (playing) {
      const clock = tick(room.game, 200);
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
    }
    const empty = room.players.every((player) => !player?.connected);
    if (empty && now - room.touched > 10 * 60 * 1000) rooms.delete(code);
  }
  for (const [key, times] of hits) {
    if (!times.some((time) => now - time < 60_000)) hits.delete(key);
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
