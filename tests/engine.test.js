import { applyMove, createGame, enclosures, legalMoves, moveInfo, normalizeSettings, tick } from "../public/js/engine.js";

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function surroundCenter(extraTurn) {
  const game = createGame({ rows: 3, cols: 3, extraTurn, timeMode: "none", scoreLimit: 0 });
  game.dots[1][1] = 1;
  const ring = [[0, 0], [0, 1], [0, 2], [1, 0], [1, 2], [2, 0], [2, 1], [2, 2]];
  for (const [r, c] of ring.slice(0, 7)) game.dots[r][c] = 0;
  game.current = 0;
  game.movesPlayed = 8;
  const result = applyMove(game, { r: 2, c: 2 });
  return { game, result };
}

const extra = surroundCenter(true);
assert(extra.result.ok && extra.result.completed === 1, "encercler le point adverse doit marquer");
assert(extra.game.scores[0] === 1 && extra.game.scores[1] === 0, "seul l'auteur du contour marque");
assert(extra.game.current === 0, "la règle classique fait rejouer");
assert(extra.game.framed[1][1] === 0, "le point adverse est encerclé");
const frames = enclosures(extra.game);
assert(frames.length === 1 && frames[0].player === 0, "un seul contour, d'une seule couleur");
assert(frames[0].loop.length === 8, "le contour passe par les points de celui qui encercle");
assert(frames[0].captured.some((dot) => dot.r === 1 && dot.c === 1), "le point adverse est à l'intérieur");

const diamond = createGame({ rows: 2, cols: 2, extraTurn: false, timeMode: "none" });
diamond.dots[1][1] = 1;
diamond.dots[0][1] = 0;
diamond.dots[1][0] = 0;
diamond.dots[1][2] = 0;
diamond.current = 0;
const losange = applyMove(diamond, { r: 2, c: 1 });
assert(losange.completed === 1 && diamond.scores[0] === 1, "le losange oblique empoche le point du milieu");
const diamondFrames = enclosures(diamond);
assert(diamondFrames.length === 1, "le losange se dessine");
assert(diamondFrames[0].loop.some((dot, index) => {
  const next = diamondFrames[0].loop[(index + 1) % diamondFrames[0].loop.length];
  return Math.abs(dot.r - next.r) === 1 && Math.abs(dot.c - next.c) === 1;
}), "les côtés du losange sont obliques");

function eatHouse() {
  const game = createGame({ rows: 4, cols: 4, extraTurn: false, timeMode: "none" });
  game.current = 1;
  applyMove(game, { r: 2, c: 2 });
  for (const [r, c] of [[1, 1], [1, 2], [1, 3], [2, 1], [2, 3], [3, 1], [3, 2], [3, 3]]) {
    game.current = 0;
    applyMove(game, { r, c });
  }
  const border = [];
  for (let i = 0; i < 5; i += 1) border.push([0, i], [4, i], [i, 0], [i, 4]);
  const unique = [];
  const seen = new Set();
  for (const [r, c] of border) {
    const key = `${r},${c}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push([r, c]);
  }
  for (const [r, c] of unique) {
    game.current = 1;
    applyMove(game, { r, c });
  }
  return game;
}

const eaten = eatHouse();
assert(eaten.scores[0] === 0, "la maison mangée perd son point");
assert(eaten.scores[1] === 1, "contourner une maison vaut 1 point");
assert(eaten.framed[2][2] != null, "l'enfant mangé ne sert plus");
assert(eaten.framed[1][1] === 1, "les points de la maison mangée ne construisent plus");

const crowded = createGame({ rows: 3, cols: 3, extraTurn: false, timeMode: "none" });
crowded.dots[1][1] = 1;
crowded.dots[1][2] = 1;
const wall = [[0, 0], [0, 1], [0, 2], [0, 3], [1, 0], [1, 3], [2, 0], [2, 1], [2, 2], [2, 3]];
for (const [r, c] of wall.slice(0, -1)) crowded.dots[r][c] = 0;
crowded.current = 0;
const oneHouse = applyMove(crowded, { r: 2, c: 3 });
assert(oneHouse.completed === 1 && crowded.scores[0] === 1, "une maison vaut 1 point, pas un point par enfant");

const dead = createGame({ rows: 3, cols: 3, extraTurn: false, timeMode: "none" });
dead.dots[1][1] = 1;
dead.framed[1][1] = 0;
dead.dots[1][2] = 0;
dead.dots[0][2] = 1;
dead.dots[2][2] = 1;
dead.dots[1][3] = 1;
assert(enclosures(dead).length === 0, "un enfant déjà mangé ne ferme pas une maison");

const once = surroundCenter(false);
assert(once.game.current === 1, "sans rejeu, le tour passe");

const empty = createGame({ rows: 2, cols: 2, extraTurn: true, timeMode: "none" });
const emptyRing = [[0, 0], [0, 1], [0, 2], [1, 0], [1, 2], [2, 0], [2, 1], [2, 2]];
for (const [r, c] of emptyRing.slice(0, 7)) empty.dots[r][c] = 0;
empty.current = 0;
const hollow = applyMove(empty, { r: 2, c: 2 });
assert(hollow.completed === 0 && empty.scores[0] === 0, "un contour vide ne marque pas");
assert(enclosures(empty).length === 0, "un contour vide ne se dessine pas");

const mixed = createGame({ rows: 2, cols: 2, extraTurn: true, timeMode: "none" });
mixed.dots[0][0] = 0;
mixed.dots[0][1] = 1;
mixed.dots[1][0] = 1;
mixed.current = 0;
const mixedResult = applyMove(mixed, { r: 1, c: 1 });
assert(mixedResult.completed === 0 && enclosures(mixed).length === 0, "quatre coins de deux couleurs ne forment pas un cadre");

const fresh = createGame({ rows: 2, cols: 2, extraTurn: true, timeMode: "none" });
assert(applyMove(fresh, { r: 0, c: 0 }).ok, "premier point accepté");
assert(!applyMove(fresh, { r: 0, c: 0 }).ok, "point déjà posé refusé");
assert(!applyMove(fresh, { r: 9, c: 0 }).ok, "point hors plateau refusé");
assert(moveInfo(fresh, { r: 0, c: 0 }).ok === false, "moveInfo voit le point occupé");

const limited = surroundCenter(true);
limited.game.settings.scoreLimit = 1;
limited.game.status = "playing";
limited.game.houses = [];
limited.game.scores[0] = 0;
limited.game.framed[1][1] = null;
limited.game.dots[2][2] = null;
limited.game.current = 0;
const scored = applyMove(limited.game, { r: 2, c: 2 });
assert(scored.completed === 1, "le point encerclé compte pour la limite");
assert(limited.game.status === "finished" && limited.game.winner === 0 && limited.game.reason === "score", "objectif de score");

const timed = createGame({ rows: 2, cols: 2, timeMode: "global", timeLimit: 30 });
timed.globalRemaining = 50;
const clock = tick(timed, 80);
assert(clock.timedOut && clock.kind === "global", "chrono global");
assert(timed.status === "finished" && timed.winner === "draw", "égalité au temps");

const turn = createGame({ rows: 2, cols: 2, timeMode: "turn", timeLimit: 10 });
const expired = tick(turn, 10001);
assert(expired.timedOut && expired.kind === "turn", "temps par tour");
assert(turn.status === "playing", "le temps par tour ne termine pas seul");

let filled = createGame({ rows: 2, cols: 2, extraTurn: false, timeMode: "none" });
let guard = 0;
while (filled.status === "playing" && guard < 20) {
  applyMove(filled, legalMoves(filled)[0]);
  guard += 1;
}
assert(filled.status === "finished", "la partie se termine");
const living = filled.houses.filter((house) => house.alive).length;
assert(filled.scores[0] + filled.scores[1] === living, "chaque point est une maison");

const settings = normalizeSettings({ rows: 99, cols: 0, p1Color: "blue", p2Color: "blue", p1Name: "  Ada  " });
assert(settings.rows === 32 && settings.cols === 2, "tailles bornées");
assert(settings.p1Color !== settings.p2Color, "couleurs distinctes");
assert(settings.p1Name === "Ada", "nom nettoyé");

const wide = createGame({ rows: 8, cols: 10, extraTurn: false, timeMode: "none" });
wide.dots[4][5] = 1;
const border = [];
for (let r = 2; r <= 6; r += 1) {
  for (let c = 2; c <= 8; c += 1) {
    if (r === 2 || r === 6 || c === 2 || c === 8) border.push([r, c]);
  }
}
for (const [r, c] of border.slice(0, -1)) wide.dots[r][c] = 0;
wide.dots[1][8] = 0;
wide.dots[1][9] = 0;
wide.dots[2][9] = 0;
wide.current = 0;
const big = applyMove(wide, { r: border.at(-1)[0], c: border.at(-1)[1] });
assert(big.completed === 1 && wide.scores[0] === 1, "un grand contour, même avec un prolongement, se ferme");
assert(enclosures(wide).length === 1 && enclosures(wide)[0].loop.length >= 8, "le grand cadre se dessine");

const yard = createGame({ rows: 6, cols: 6, extraTurn: false, timeMode: "none" });
yard.dots[3][3] = 1;
const fence = [];
for (let r = 1; r <= 5; r += 1) {
  for (let c = 1; c <= 5; c += 1) {
    if (r === 1 || r === 5 || c === 1 || c === 5) fence.push([r, c]);
  }
}
for (const [r, c] of fence.slice(0, -1)) yard.dots[r][c] = 0;
yard.current = 0;
applyMove(yard, { r: fence.at(-1)[0], c: fence.at(-1)[1] });
assert(!legalMoves(yard).some((move) => move.r === 3 && move.c === 2), "l'intérieur mangé n'est plus jouable");
assert(applyMove(yard, { r: 4, c: 4 }).ok === false, "personne ne rejoue dans la maison");

console.log("engine ok");
