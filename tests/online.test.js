import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { io } = require("../node_modules/socket.io/client-dist/socket.io.js");

const url = process.env.DOTS_URL || "http://localhost:4173";

function connect(name) {
  return new Promise((resolve, reject) => {
    const socket = io(url, { transports: ["websocket"] });
    const timer = setTimeout(() => reject(new Error(`${name} ne se connecte pas`)), 4000);
    socket.on("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
  });
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

const host = await connect("hôte");
const guest = await connect("invité");
const hostStates = [];
const guestStates = [];
host.on("state", (state) => hostStates.push(state));
guest.on("state", (state) => guestStates.push(state));

const created = await new Promise((resolve) => {
  host.emit("create", {
    playerId: "ada",
    name: "Ada",
    settings: {
      rows: 2,
      cols: 2,
      p1Color: "blue",
      p2Color: "green",
      extraTurn: true,
      timeMode: "none",
      scoreLimit: 0,
    },
  }, resolve);
});
assert(created.ok && /^EGD-\d{4}$/.test(created.code), "code de salle");

const joined = await new Promise((resolve) => {
  guest.emit("join", { playerId: "blaise", name: "Blaise", code: created.code, color: "green" }, resolve);
});
assert(joined.ok, joined.error || "rejoindre");

await new Promise((resolve) => setTimeout(resolve, 200));
const started = hostStates.find((state) => state.game);
assert(started?.game?.rows === 2, "la partie commence en 2×2");
assert(guestStates.some((state) => state.game && state.you === 1), "l'invité est le joueur 2");

const move = { r: 0, c: 0 };
const played = await new Promise((resolve) => host.emit("move", move, resolve));
assert(played.ok, played.error || "coup refusé");
await new Promise((resolve) => setTimeout(resolve, 150));
const seen = guestStates.some((state) => state.game?.dots?.[0]?.[0] === 0);
assert(seen, "le coup est visible des deux côtés");

const rejected = await new Promise((resolve) => guest.emit("move", move, resolve));
assert(!rejected.ok, "un point déjà joué doit être refusé");

host.close();
guest.close();
console.log("online ok", created.code);
