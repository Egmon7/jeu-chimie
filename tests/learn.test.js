import assert from "assert/strict";
import { createGame, applyMove } from "../public/js/engine.js";
import {
  boardSnap,
  learnFingerprint,
  packGrid,
  unpackGrid,
  replayLearnMoves,
  sameSnapScores,
} from "../server/learn.js";

const grid = [
  [null, 0, 1],
  [1, null, 0],
];
assert.equal(packGrid(grid), "-01/1-0");
assert.deepEqual(unpackGrid("-01/1-0", 1, 2), grid);

assert.equal(
  learnFingerprint("b", "a", 100, 8, 10),
  learnFingerprint("a", "b", 100, 8, 10),
);
assert.notEqual(
  learnFingerprint("a", "b", 100, 8, 10),
  learnFingerprint("a", "b", 101, 8, 10),
);

const settings = { rows: 4, cols: 4, extraTurn: false, timeMode: "none", scoreLimit: 0 };
const live = createGame(settings);
const path = [];
for (const [r, c] of [[0, 0], [0, 1], [1, 0], [1, 1]]) {
  const before = boardSnap(live);
  const seat = live.current;
  const result = applyMove(live, { r, c });
  assert.equal(result.ok, true);
  path.push({ step: path.length, seat, r, c, before, after: boardSnap(live) });
}

const replayed = replayLearnMoves(settings, 0, path);
assert.equal(replayed.movesPlayed, 4);
assert.equal(replayed.dots[0][0], 0);
assert.equal(replayed.dots[0][1], 1);
assert.equal(replayed.dots[1][0], 0);
assert.equal(replayed.dots[1][1], 1);
assert.ok(sameSnapScores(path.at(-1).after, replayed));

const house = createGame(settings);
house.dots[2][2] = 1;
house.dots[1][2] = 0;
house.dots[2][3] = 0;
house.dots[3][2] = 0;
house.current = 0;
const beforeHouse = boardSnap(house);
assert.equal(applyMove(house, { r: 2, c: 1 }).completed, 1);
assert.equal(beforeHouse.scores[0], 0);
assert.equal(boardSnap(house).scores[0], 1);

console.log("learn ok");
