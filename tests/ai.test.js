import { chooseMove } from "../public/js/ai.js";
import { applyMove, createGame, legalMoves } from "../public/js/engine.js";

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function almostSurrounded() {
  const game = createGame({ rows: 2, cols: 2, extraTurn: true, timeMode: "none" });
  game.dots[1][1] = 1;
  for (const [r, c] of [[0, 0], [0, 1], [0, 2], [1, 0], [1, 2], [2, 0], [2, 1]]) game.dots[r][c] = 0;
  game.current = 0;
  return game;
}

for (const level of ["easy", "medium", "hard", "veryhard", "expert"]) {
  const move = chooseMove(almostSurrounded(), level);
  assert(move && move.r === 2 && move.c === 2, `${level} ferme le contour`);
}

const easyGame = createGame({ rows: 3, cols: 3, extraTurn: true, timeMode: "none" });
const easyMove = chooseMove(easyGame, "easy");
assert(easyMove && Number.isInteger(easyMove.r) && Number.isInteger(easyMove.c), "facile pose un point");

const started = performance.now();
const expertMove = chooseMove(createGame({ rows: 5, cols: 5, extraTurn: true, timeMode: "none" }), "expert");
assert(expertMove, "expert trouve un coup");
// Le budget de l'expert est de 320 ms ; la marge couvre une machine chargée (tests lancés en parallèle).
assert(performance.now() - started < 1000, "expert répond vite");

let game = createGame({ rows: 3, cols: 3, extraTurn: true, timeMode: "none" });
let guard = 0;
while (game.status === "playing" && guard < 40) {
  const move = chooseMove(game, guard % 2 === 0 ? "hard" : "expert");
  assert(move, "coup disponible");
  const result = applyMove(game, move);
  assert(result.ok, "coup légal");
  guard += 1;
}
assert(game.status === "finished", "une partie IA se termine");
assert(legalMoves(game).length === 0 || game.reason === "score", "plateau épuisé");

// Le sel (tiré au hasard à chaque partie) départage les coups de même valeur :
// le test le fixe pour donner toujours le même résultat.
function startedRing(salt = 7) {
  const game = createGame({ rows: 6, cols: 6, extraTurn: true, timeMode: "none" });
  game.salt = salt;
  game.dots[3][3] = 1;
  game.dots[2][2] = 0;
  game.dots[2][3] = 0;
  game.dots[2][4] = 0;
  game.current = 0;
  return game;
}

const around = (move) => move && Math.max(Math.abs(move.r - 3), Math.abs(move.c - 3)) === 1;
const ring = startedRing();
const built = chooseMove(ring, "medium");
assert(around(built), "moyen poursuit la forme autour du point adverse");
const again = chooseMove(ring, "medium");
assert(again && again.r === built.r && again.c === built.c, "moyen rejoue le même coup");
// Sur tous les sels possibles, le moyen entoure le point adverse dans la grande majorité des parties
// (aujourd'hui environ 9 sur 10 ; l'autre coup, au-dessus de sa ligne, est voulu comme imperfection).
let pursued = 0;
const SALTS = 200;
for (let salt = 0; salt < SALTS; salt += 1) if (around(chooseMove(startedRing(salt * 5), "medium"))) pursued += 1;
assert(pursued >= SALTS * 0.85, `moyen poursuit la forme dans la plupart des parties (${pursued}/${SALTS})`);

const opening = chooseMove(createGame({ rows: 5, cols: 5, extraTurn: true, timeMode: "none" }), "medium");
assert(opening && Math.max(Math.abs(opening.r - 3), Math.abs(opening.c - 3)) <= 1, "moyen ouvre près du centre");
const other = createGame({ rows: 5, cols: 5, extraTurn: true, timeMode: "none" });
let shifted = false;
for (let salt = 0; salt < 40 && !shifted; salt += 1) {
  other.salt = salt;
  const move = chooseMove(other, "medium");
  shifted = move && (move.r !== opening.r || move.c !== opening.c);
}
assert(shifted, "deux parties n'ouvrent pas toujours au même point");

function mustCounter() {
  const game = createGame({ rows: 4, cols: 4, extraTurn: true, timeMode: "none" });
  game.dots[1][1] = 0;
  for (const [r, c] of [[0, 0], [0, 1], [0, 2], [1, 0], [1, 2], [2, 0], [2, 1]]) game.dots[r][c] = 1;
  game.current = 0;
  return game;
}

const block = chooseMove(mustCounter(), "medium");
assert(block && block.r === 2 && block.c === 2, "moyen contre le contour adverse");

console.log("ai ok");
