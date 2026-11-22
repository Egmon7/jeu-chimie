import assert from "assert/strict";
import { createGame, applyMove } from "../public/js/engine.js";
import { boardSnap } from "../server/learn.js";
import { analyzeLearnMatch, patternsFromTimeline, summarizeSituations } from "../server/learnAnalyze.js";

assert.deepEqual(analyzeLearnMatch(null), []);
assert.deepEqual(analyzeLearnMatch({ moves: [] }), []);

const settings = { rows: 6, cols: 6, extraTurn: true, timeMode: "none", scoreLimit: 0 };
const game = createGame(settings);
game.dots[2][2] = 1;
game.dots[1][2] = 0;
game.dots[2][1] = 0;
game.dots[2][3] = 0;
game.current = 0;
const before = boardSnap(game);
const result = applyMove(game, { r: 3, c: 2 });
assert.equal(result.ok && result.completed, 1);
const moves = [{ step: 0, seat: 0, r: 3, c: 2, before, after: boardSnap(game) }];

const found = analyzeLearnMatch({
  rows: 6,
  cols: 6,
  starter: 0,
  winner: "0",
  settings,
  moves,
});
assert.ok(found.some((row) => row.kind === "chain_short"));
assert.ok(found.filter((row) => row.kind.startsWith("chain")).every((row) => row.outcome === "win"));

const doubles = patternsFromTimeline([
  { step: 0, seat: 0, gained: 0 },
  { step: 1, seat: 1, gained: 1 },
  { step: 2, seat: 0, gained: 1 },
  { step: 3, seat: 0, gained: 1 },
], "0");
assert.ok(doubles.some((row) => row.kind === "double_cross" && row.outcome === "win"));

const sacrifice = patternsFromTimeline([
  { step: 0, seat: 0, gained: 0 },
  { step: 1, seat: 1, gained: 2 },
  { step: 2, seat: 0, gained: 3 },
], "1");
assert.ok(sacrifice.some((row) => row.kind === "sacrifice" && row.outcome === "loss"));

assert.equal(patternsFromTimeline([
  { step: 0, seat: 0, gained: 0 },
  { step: 1, seat: 1, gained: 0 },
], "0").length, 0, "rien inventé sans captures dans les coups");

const summary = summarizeSituations(found);
assert.equal(summary.total, found.length);
assert.ok(summary.byOutcome.win >= 1);

console.log("learnAnalyze ok");
