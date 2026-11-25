import assert from "assert/strict";
import { analyzeLearnMatch, summarizeSituations } from "../server/learnAnalyze.js";

assert.deepEqual(analyzeLearnMatch(null), []);
assert.deepEqual(analyzeLearnMatch({ moves: [] }), []);

const settings = { rows: 6, cols: 6, extraTurn: true, timeMode: "none", scoreLimit: 0 };
const match = (moves, winner) => ({
  rows: 6,
  cols: 6,
  starter: 0,
  winner,
  settings,
  moves: moves.map(([seat, r, c], step) => ({ step, seat, r, c })),
});
const kindsOf = (found, kind) => found.filter((row) => row.kind === kind);

// 1) Le joueur 1 pose son point au milieu de trois points du joueur 0 (maison laissée),
//    puis le joueur 0 ferme la maison (encerclement réussi, première maison).
{
  const found = analyzeLearnMatch(match([
    [0, 1, 2], [1, 5, 5],
    [0, 2, 1], [1, 5, 4],
    [0, 2, 3], [1, 2, 2],
    [0, 3, 2],
  ], "0"));
  const encircle = kindsOf(found, "encircle");
  assert.equal(encircle.length, 1, "un encerclement réussi");
  assert.equal(encircle[0].seat, 0);
  assert.equal(encircle[0].outcome, "win");
  const first = kindsOf(found, "first_house");
  assert.equal(first.length, 1, "une seule première maison");
  assert.equal(first[0].step, 6);
  const left = kindsOf(found, "left_open");
  assert.equal(left.length, 1, "le joueur 1 a laissé la maison");
  assert.equal(left[0].seat, 1);
  assert.equal(left[0].step, 5);
  assert.equal(left[0].outcome, "loss");
  assert.equal(kindsOf(found, "missed").length, 0, "pas d’occasion manquée : la maison a été prise");
}

// 2) Le joueur 0 pouvait fermer mais joue ailleurs (occasion manquée),
//    puis le joueur 1 prend le point qui fermait (encerclement bloqué).
{
  const found = analyzeLearnMatch(match([
    [0, 1, 2], [1, 5, 5],
    [0, 2, 1], [1, 5, 4],
    [0, 2, 3], [1, 2, 2],
    [0, 0, 6], [1, 3, 2],
  ], "1"));
  const missed = kindsOf(found, "missed");
  assert.equal(missed.length, 1, "une occasion manquée");
  assert.equal(missed[0].seat, 0);
  assert.equal(missed[0].step, 6);
  const blocked = kindsOf(found, "blocked");
  assert.equal(blocked.length, 1, "un encerclement bloqué");
  assert.equal(blocked[0].seat, 1);
  assert.equal(blocked[0].step, 7);
  assert.equal(blocked[0].outcome, "win");
  assert.equal(kindsOf(found, "encircle").length, 0, "aucune maison fermée");
  assert.equal(kindsOf(found, "left_open").length, 0, "rien de laissé : l’autre n’a pas fermé");
}

// 3) Rien d'inventé : des coups sans encerclement ne donnent aucune situation.
{
  const found = analyzeLearnMatch(match([[0, 0, 0], [1, 6, 6], [0, 0, 6], [1, 6, 0]], "draw"));
  assert.equal(found.length, 0, "aucune situation sans rien d’encerclé");
}

// 4) Résumé.
{
  const found = analyzeLearnMatch(match([
    [0, 1, 2], [1, 5, 5], [0, 2, 1], [1, 5, 4], [0, 2, 3], [1, 2, 2], [0, 3, 2],
  ], "0"));
  const summary = summarizeSituations(found);
  assert.equal(summary.total, found.length);
  assert.ok(summary.byOutcome.win >= 2);
  assert.ok(summary.byKind.encircle === 1 && summary.byKind.first_house === 1);
}

console.log("learnAnalyze ok");
