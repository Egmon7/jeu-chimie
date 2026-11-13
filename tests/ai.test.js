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

for (const level of ["medium", "hard", "veryhard", "expert"]) {
  const move = chooseMove(almostSurrounded(), level);
  assert(move && move.r === 2 && move.c === 2, `${level} ferme le contour`);
}

const easyGame = createGame({ rows: 3, cols: 3, extraTurn: true, timeMode: "none" });
const easyMove = chooseMove(easyGame, "easy");
assert(easyMove && Number.isInteger(easyMove.r) && Number.isInteger(easyMove.c), "facile pose un point");

const started = performance.now();
const expertMove = chooseMove(createGame({ rows: 5, cols: 5, extraTurn: true, timeMode: "none" }), "expert");
assert(expertMove, "expert trouve un coup");
assert(performance.now() - started < 500, "expert répond vite");

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

function startedRing() {
  const game = createGame({ rows: 6, cols: 6, extraTurn: true, timeMode: "none" });
  game.dots[3][3] = 1;
  game.dots[2][2] = 0;
  game.dots[2][3] = 0;
  game.dots[2][4] = 0;
  game.current = 0;
  return game;
}

const built = chooseMove(startedRing(), "medium");
assert(built && Math.max(Math.abs(built.r - 3), Math.abs(built.c - 3)) === 1, "moyen poursuit la forme autour du point adverse");
const again = chooseMove(startedRing(), "medium");
assert(again && again.r === built.r && again.c === built.c, "moyen rejoue le même coup");

const opening = chooseMove(createGame({ rows: 5, cols: 5, extraTurn: true, timeMode: "none" }), "medium");
assert(opening && opening.r === 3 && opening.c === 3, "moyen ouvre au centre");

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
