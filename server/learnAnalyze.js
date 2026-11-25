import { applyMove, createGame } from "../public/js/engine.js";
import { closingMoves } from "../public/js/ai.js";

/**
 * Les situations repérées dans ce jeu d'encerclement, lues en rejouant la partie coup par coup.
 * Rien n'est inventé : chaque situation correspond à un coup réellement joué.
 */
export const LEARN_SITUATION_KINDS = ["first_house", "encircle", "eat", "blocked", "missed", "left_open"];

function seatOutcome(seat, winner) {
  if (winner === "draw" || winner == null || winner === "") return "draw";
  const w = Number(winner);
  if (w !== 0 && w !== 1) return "draw";
  return w === seat ? "win" : "loss";
}

const cellKey = (move) => `${move.r},${move.c}`;

export function analyzeLearnMatch(match) {
  const situations = [];
  const moves = match?.moves;
  if (!Array.isArray(moves) || !moves.length) return situations;
  const settings = {
    ...(match.settings && typeof match.settings === "object" ? match.settings : {}),
    rows: match.rows ?? match.settings?.rows,
    cols: match.cols ?? match.settings?.cols,
  };
  const game = createGame(settings, match.starter === 1 ? 1 : 0);
  const winner = match.winner;
  const add = (kind, step, seat, size, detail = {}) => {
    situations.push({ step, kind, seat, outcome: seatOutcome(seat, winner), size, detail });
  };
  const timeline = [];
  let firstDone = false;
  for (const [index, move] of moves.entries()) {
    if (game.status !== "playing") break;
    const step = Number.isInteger(move.step) ? move.step : index;
    const seat = move.seat === 1 ? 1 : move.seat === 0 ? 0 : game.current;
    game.current = seat;
    // Ce que chacun pouvait fermer juste avant ce coup.
    const mine = closingMoves(game, seat);
    const theirs = closingMoves(game, 1 - seat);
    const play = { r: Number(move.r), c: Number(move.c) };
    const result = applyMove(game, play);
    if (!result.ok) break;
    const completed = Number(result.completed) || 0;
    const eaten = Number(result.eaten) || 0;
    if (completed > 0) {
      add("encircle", step, seat, completed);
      if (!firstDone) {
        firstDone = true;
        add("first_house", step, seat, completed);
      }
    }
    if (eaten > 0) add("eat", step, seat, eaten);
    if (!completed && !eaten && mine.length) {
      add("missed", step, seat, Math.max(...mine.map((item) => item.completes)), { could: mine.slice(0, 3).map((item) => item.move) });
    }
    const block = theirs.find((item) => cellKey(item.move) === cellKey(play));
    if (block && !completed) add("blocked", step, seat, block.completes);
    timeline.push({ step, seat, gained: completed + eaten, threatsBefore: new Set(theirs.map((item) => cellKey(item.move))), play });
  }
  // Maison laissée : après ce coup, l'adversaire ferme tout de suite une maison qu'il ne pouvait pas fermer avant.
  for (let i = 0; i + 1 < timeline.length; i += 1) {
    const cur = timeline[i];
    const next = timeline[i + 1];
    if (cur.gained > 0 || next.seat === cur.seat || next.gained <= 0) continue;
    if (cur.threatsBefore.has(cellKey(next.play))) continue;
    add("left_open", cur.step, cur.seat, next.gained, { replyStep: next.step });
  }
  return situations;
}

export function summarizeSituations(rows) {
  const byKind = {};
  const byOutcome = { win: 0, loss: 0, draw: 0 };
  for (const row of rows || []) {
    byKind[row.kind] = (byKind[row.kind] || 0) + 1;
    const key = row.outcome === "win" || row.outcome === "loss" ? row.outcome : "draw";
    byOutcome[key] += 1;
  }
  return { total: rows?.length || 0, byKind, byOutcome };
}
