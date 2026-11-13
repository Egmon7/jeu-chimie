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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);
const rooms = new Map();

app.use(express.static(path.join(__dirname, "../public")));

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
    const settings = normalizeSettings({ ...payload.settings, p1Name: payload.name });
    const code = makeRoomCode(rooms);
    const room = {
      code,
      settings,
      game: null,
      players: [
        {
          id: String(payload.playerId || socket.id),
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
    const code = String(payload.code || "").trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return ack?.({ ok: false, error: "Salle introuvable." });
    const existing = seatOf(room, payload.playerId);
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
    room.players[1] = { id: String(payload.playerId || socket.id), name, color, socketId: socket.id, connected: true };
    room.game = createGame(room.settings, 0);
    attach(socket, room, 1, room.players[1].id);
    ack?.({ ok: true, code });
    emitState(room, { type: "start" });
  });

  socket.on("rejoin", (payload = {}, ack) => {
    const room = rooms.get(String(payload.code || "").toUpperCase());
    const seat = room ? seatOf(room, payload.playerId) : -1;
    if (!room || seat < 0) return ack?.({ ok: false });
    attach(socket, room, seat, payload.playerId);
    ack?.({ ok: true, code: room.code });
    emitState(room, { type: "rejoin" });
  });

  socket.on("move", (move, ack) => {
    const room = rooms.get(socket.data.roomCode);
    const seat = room ? seatOf(room, socket.data.playerId) : -1;
    if (!room?.game || room.game.status !== "playing") return ack?.({ ok: false, error: "Partie inactive." });
    if (seat !== room.game.current) return ack?.({ ok: false, error: "Ce n'est pas votre tour." });
    const result = applyMove(room.game, move);
    if (!result.ok) return ack?.({ ok: false, error: "Coup impossible." });
    room.rematch = [false, false];
    ack?.({ ok: true });
    emitState(room, { type: "move", move, result });
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
  room.players[seat].socketId = socket.id;
  room.players[seat].connected = true;
  room.players[seat].id = String(playerId);
  socket.join(room.code);
  socket.data.roomCode = room.code;
  socket.data.playerId = room.players[seat].id;
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
}, 200);

const port = Number(process.env.PORT) || 4173;
httpServer.listen(port, () => {
  console.log(`Egmon Dots prêt sur http://localhost:${port}`);
});
