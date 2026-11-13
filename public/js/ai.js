import { legalMoves, moveInfo } from "./engine.js";

const NEAR = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];
const ORTHO = [[-1, 0], [1, 0], [0, -1], [0, 1]];

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function inside(game, r, c) {
  return r >= 0 && c >= 0 && r <= game.rows && c <= game.cols;
}

function ownerAt(game, r, c) {
  if (!inside(game, r, c)) return null;
  return game.dots[r][c];
}

function dotsOf(game, player) {
  const list = [];
  for (let r = 0; r <= game.rows; r += 1) {
    for (let c = 0; c <= game.cols; c += 1) {
      if (game.dots[r][c] === player) list.push({ r, c });
    }
  }
  return list;
}

function withPlayer(game, player, run) {
  const saved = game.current;
  game.current = player;
  try {
    return run();
  } finally {
    game.current = saved;
  }
}

function capturingMoves(game, player) {
  return withPlayer(game, player, () => {
    const found = [];
    for (const move of legalMoves(game)) {
      const info = moveInfo(game, move);
      if (info.completes > 0) found.push({ move, completes: info.completes });
    }
    return found;
  });
}

function bestCapture(list) {
  if (!list.length) return null;
  list.sort((a, b) => b.completes - a.completes);
  const best = list[0].completes;
  return pick(list.filter((item) => item.completes === best)).move;
}

function attachedScore(game, player, r, c) {
  let ortho = 0;
  let diag = 0;
  for (const [dr, dc] of ORTHO) {
    if (ownerAt(game, r + dr, c + dc) === player) ortho += 1;
  }
  for (const [dr, dc] of NEAR) {
    if (dr !== 0 && dc !== 0 && ownerAt(game, r + dr, c + dc) === player) diag += 1;
  }
  return ortho * 6 + diag * 2;
}

function ringProgress(game, player, dot) {
  let ours = 0;
  let gaps = 0;
  for (const [dr, dc] of NEAR) {
    const who = ownerAt(game, dot.r + dr, dot.c + dc);
    if (who === player) ours += 1;
    else if (who == null && inside(game, dot.r + dr, dot.c + dc)) gaps += 1;
  }
  return { ours, gaps };
}

function shapeScore(game, player, move) {
  const { r, c } = move;
  const mine = dotsOf(game, player);
  const others = dotsOf(game, 1 - player);
  let score = attachedScore(game, player, r, c);

  if (!mine.length) {
    score -= Math.abs(r - game.rows / 2) + Math.abs(c - game.cols / 2);
    for (const dot of others) {
      const dist = Math.max(Math.abs(dot.r - r), Math.abs(dot.c - c));
      if (dist <= 2) score += (3 - dist) * 8;
    }
    return score;
  }

  if (score === 0) score -= 12;

  for (const dot of others) {
    const dist = Math.max(Math.abs(dot.r - r), Math.abs(dot.c - c));
    if (dist > 2) continue;
    const ring = ringProgress(game, player, dot);
    if (dist === 1) score += 16 + ring.ours * 4 + (ring.gaps <= 2 ? 10 : 0);
    else if (score > 0) score += 5;
  }

  for (const dot of mine) {
    if (Math.max(Math.abs(dot.r - r), Math.abs(dot.c - c)) !== 1) continue;
    const ring = ringProgress(game, 1 - player, dot);
    if (ring.ours >= 2) score += 8 + ring.ours * 2;
  }
  return score;
}

function rankedMoves(game, player, moves) {
  return moves
    .map((move) => ({ move, score: shapeScore(game, player, move) }))
    .sort((a, b) => b.score - a.score);
}

export function chooseMove(game, difficulty = "medium") {
  const moves = legalMoves(game);
  if (!moves.length || game.status !== "playing") return null;
  const player = game.current;
  if (difficulty === "easy") return pick(moves);

  const capture = bestCapture(capturingMoves(game, player));
  if (capture) return capture;

  const threats = capturingMoves(game, 1 - player);
  if (threats.length) {
    threats.sort((a, b) => b.completes - a.completes);
    const best = threats[0].completes;
    const blocks = threats
      .filter((item) => item.completes === best)
      .map((item) => ({ move: item.move, score: shapeScore(game, player, item.move) }))
      .sort((a, b) => b.score - a.score);
    const top = blocks[0].score;
    return pick(blocks.filter((item) => item.score === top)).move;
  }

  const ranked = rankedMoves(game, player, moves);
  if (difficulty === "medium") {
    const top = ranked[0].score;
    return pick(ranked.filter((item) => item.score === top)).move;
  }

  const slack = difficulty === "expert" ? 2 : 4;
  const window = ranked.filter((item) => item.score >= ranked[0].score - slack).slice(0, difficulty === "expert" ? 8 : 5);
  let choice = window[0];
  let bestValue = -Infinity;
  for (const item of window) {
    game.dots[item.move.r][item.move.c] = player;
    const replyHit = capturingMoves(game, 1 - player).reduce((n, hit) => Math.max(n, hit.completes), 0);
    let threat = 0;
    if (difficulty === "expert" && replyHit === 0) {
      threat = capturingMoves(game, player).reduce((n, hit) => Math.max(n, hit.completes), 0);
    }
    game.dots[item.move.r][item.move.c] = null;
    const value = item.score + threat * 25 - replyHit * 40;
    if (value > bestValue) {
      bestValue = value;
      choice = item;
    }
  }
  return choice.move;
}
