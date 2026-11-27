import { applyMove, cloneGame, dotIsOpen, legalMoves, moveInfo } from "./engine.js";

const NEAR = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];
const ORTHO = [[-1, 0], [1, 0], [0, -1], [0, 1]];

/** Version du robot qui joue. */
export const ROBOT_VERSION = "v2";

/** Les réglages du robot v1, gardés pour la comparaison (les anciens niveaux). */
export const V1_PROFILE = {
  easy: { depth: 1, window: 4, reply: 3, fork: 0, chain: 1, ms: 40, max: 80 },
  medium: { depth: 2, window: 5, reply: 4, fork: 1, chain: 2, ms: 80, max: 180 },
  hard: { depth: 3, window: 7, reply: 5, fork: 2, chain: 4, ms: 140, max: 360 },
  veryhard: { depth: 4, window: 8, reply: 6, fork: 3, chain: 5, ms: 220, max: 560 },
  expert: { depth: 4, window: 8, reply: 6, fork: 4, chain: 6, ms: 320, max: 800 },
};

/**
 * Robot v2. Les joueurs battaient l'ancien Difficile 83 % du temps et l'ancien Expert 90 % :
 * - Facile = l'ancien Difficile, Moyen = l'ancien Expert ;
 * - Difficile et Expert jouent la v2 (« Très difficile » est retiré), qui applique ce que l'apprentissage a montré :
 *   ne pas laisser de maison à l'autre (83 parties perdues sur 99 viennent de là) et chercher les doubles
 *   menaces. Mesuré en Expert sur 12×12 : 13 victoires v2, 6 v1, 5 nuls (24 parties).
 */
const PROFILE = {
  easy: { ...V1_PROFILE.hard },
  medium: { ...V1_PROFILE.expert, deep: true },
  hard: { depth: 3, window: 8, reply: 5, fork: 3, chain: 4, ms: 200, max: 500, v2: true },
  expert: { depth: 4, window: 10, reply: 7, fork: 5, chain: 6, ms: 450, max: 1200, v2: true, deep: true },
};
// « Très difficile » est retiré : une ancienne partie à ce niveau joue comme l'Expert.
PROFILE.veryhard = PROFILE.expert;

function prefer(game, a, b) {
  const salt = game.salt || 0;
  const ka = (a.r * 31 + a.c * 17 + salt * 13) % 97;
  const kb = (b.r * 31 + b.c * 17 + salt * 13) % 97;
  return ka - kb || a.c - b.c || a.r - b.r;
}

function inside(game, r, c) {
  return r >= 0 && c >= 0 && r <= game.rows && c <= game.cols;
}

function aliveDots(game, player) {
  const list = [];
  for (let r = 0; r <= game.rows; r += 1) {
    for (let c = 0; c <= game.cols; c += 1) {
      if (game.dots[r][c] === player && game.framed[r][c] == null) list.push({ r, c });
    }
  }
  return list;
}

function focus(game, player, dist) {
  const spots = new Map();
  for (const dot of aliveDots(game, player)) {
    for (let dr = -dist; dr <= dist; dr += 1) {
      for (let dc = -dist; dc <= dist; dc += 1) {
        if (dr === 0 && dc === 0 || Math.max(Math.abs(dr), Math.abs(dc)) > dist) continue;
        const r = dot.r + dr;
        const c = dot.c + dc;
        if (!dotIsOpen(game, { r, c })) continue;
        spots.set(`${r},${c}`, { r, c });
      }
    }
  }
  return [...spots.values()];
}

function winningMoves(game, player) {
  const saved = game.current;
  game.current = player;
  const victims = aliveDots(game, 1 - player);
  const found = [];
  const holes = focus(game, player, 1)
    .filter((move) => tightness(game, player, move) >= 2)
    .sort((a, b) => nearestDot(victims, a) - nearestDot(victims, b) || tightness(game, player, b) - tightness(game, player, a))
    .slice(0, 12);
  try {
    for (const move of holes) {
      const info = moveInfo(game, move);
      if (info.completes > 0) found.push({ move, completes: info.completes });
    }
  } finally {
    game.current = saved;
  }
  found.sort((a, b) => {
    if (b.completes !== a.completes) return b.completes - a.completes;
    const da = nearestDot(victims, a.move);
    const db = nearestDot(victims, b.move);
    if (da !== db) return da - db;
    return tightness(game, player, b.move) - tightness(game, player, a.move) || prefer(game, a.move, b.move);
  });
  return found;
}

/** Les coups qui fermeraient une maison pour ce joueur (sert aussi à l’analyse des parties gardées). */
export function closingMoves(game, player) {
  return winningMoves(game, player);
}

function nearestDot(dots, move) {
  let best = 99;
  for (const dot of dots) best = Math.min(best, Math.max(Math.abs(dot.r - move.r), Math.abs(dot.c - move.c)));
  return best;
}

function tightness(game, player, move) {
  let count = 0;
  for (const [dr, dc] of NEAR) {
    const r = move.r + dr;
    const c = move.c + dc;
    if (!inside(game, r, c)) continue;
    if (game.dots[r][c] === player && game.framed[r][c] == null) count += 1;
  }
  return count;
}

function ringAround(game, player, dot) {
  let ours = 0;
  let gaps = 0;
  for (const [dr, dc] of NEAR) {
    const r = dot.r + dr;
    const c = dot.c + dc;
    if (!inside(game, r, c)) continue;
    const who = game.dots[r][c];
    if (who === player && game.framed[r][c] == null) ours += 1;
    else if (who == null && game.framed[r][c] == null) gaps += 1;
  }
  return { ours, gaps };
}

function buildScore(game, player, move) {
  const { r, c } = move;
  const mine = aliveDots(game, player);
  const others = aliveDots(game, 1 - player);
  let score = 0;
  for (const [dr, dc] of ORTHO) {
    const nr = r + dr;
    const nc = c + dc;
    if (inside(game, nr, nc) && game.dots[nr][nc] === player && game.framed[nr][nc] == null) score += 6;
  }
  for (const [dr, dc] of NEAR) {
    if (dr === 0 || dc === 0) continue;
    const nr = r + dr;
    const nc = c + dc;
    if (inside(game, nr, nc) && game.dots[nr][nc] === player && game.framed[nr][nc] == null) score += 2;
  }
  if (mine.length && score === 0) score -= 12;

  if (!others.length) {
    score -= Math.abs(r - game.rows / 2) + Math.abs(c - game.cols / 2);
    return score;
  }

  let nearest = 99;
  for (const dot of others) {
    const dist = Math.max(Math.abs(dot.r - r), Math.abs(dot.c - c));
    nearest = Math.min(nearest, dist);
    if (dist > 2) continue;
    const ring = ringAround(game, player, dot);
    if (dist === 1) score += 18 + ring.ours * 6 + (ring.gaps <= 2 ? 12 : 0);
    else if (score > 0) score += 4 + ring.ours;
  }
  score -= nearest * 3;
  return score;
}

function byBuild(game, player) {
  const mine = aliveDots(game, player);
  const others = aliveDots(game, 1 - player);
  if (!mine.length && !others.length) {
    const cr = Math.round(game.rows / 2);
    const cc = Math.round(game.cols / 2);
    const seeds = [];
    for (let dr = -1; dr <= 1; dr += 1) {
      for (let dc = -1; dc <= 1; dc += 1) {
        const move = { r: cr + dr, c: cc + dc };
        if (dotIsOpen(game, move)) seeds.push(move);
      }
    }
    seeds.sort((a, b) => prefer(game, a, b));
    return seeds.length ? [seeds[0]] : legalMoves(game).slice(0, 1);
  }
  const pool = new Map();
  for (const move of focus(game, player, 2)) pool.set(`${move.r},${move.c}`, move);
  for (const move of focus(game, 1 - player, 2)) pool.set(`${move.r},${move.c}`, move);
  const list = [...pool.values()];
  if (!list.length) return legalMoves(game).slice(0, 1);
  list.sort((a, b) => buildScore(game, player, b) - buildScore(game, player, a) || prefer(game, a, b));
  return list;
}

function consider(game, player, limit) {
  const seen = new Set();
  const out = [];
  const push = (move) => {
    const key = `${move.r},${move.c}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(move);
  };
  for (const item of winningMoves(game, player)) push(item.move);
  for (const move of byBuild(game, player)) {
    if (out.length >= limit) break;
    push(move);
  }
  return out;
}

function pendingCount(game, player) {
  return winningMoves(game, player).length;
}

function positionValue(game, me, fork, v2 = false) {
  if (game.status !== "playing") {
    if (game.winner === me) return 9000 + game.scores[me] * 10;
    if (game.winner === "draw" || game.winner == null) return 0;
    return -9000 - game.scores[1 - me] * 10;
  }
  const diff = game.scores[me] - game.scores[1 - me];
  let shape = 0;
  for (const dot of aliveDots(game, 1 - me)) {
    const ring = ringAround(game, me, dot);
    if (ring.ours >= 2) shape += ring.ours * 3 + (ring.gaps <= 2 ? 8 : 0);
  }
  for (const dot of aliveDots(game, me)) {
    const ring = ringAround(game, 1 - me, dot);
    if (ring.ours >= 2) shape -= ring.ours * 3 + (ring.gaps <= 2 ? 8 : 0);
  }
  const mine = pendingCount(game, me);
  const opp = pendingCount(game, 1 - me);
  let value = diff * 100 + shape;
  if (game.current === me) {
    value += mine >= 2 ? 70 * fork + 80 : mine * (20 + fork * 5);
    value -= opp * 25;
  } else {
    value -= opp >= 2 ? 80 * fork + 100 : opp * (40 + fork * 8);
    value += mine >= 2 ? 60 * fork : mine * 12;
  }
  return value;
}

function search(game, me, depth, profile, alpha, beta, chainLeft) {
  profile.nodes += 1;
  const stop = depth <= 0 || profile.nodes > profile.max || performance.now() > profile.until;
  if (game.status !== "playing" || stop) return positionValue(game, me, profile.fork, profile.v2);
  const player = game.current;
  const moves = consider(game, player, profile.reply);
  if (!moves.length) return positionValue(game, me, profile.fork, profile.v2);
  let best = player === me ? -Infinity : Infinity;
  for (const move of moves) {
    const copy = cloneGame(game);
    const result = applyMove(copy, move);
    if (!result.ok) continue;
    const again = copy.status === "playing" && copy.current === player && (result.completed > 0 || result.eaten > 0);
    const value = search(
      copy,
      me,
      again && chainLeft > 0 ? depth : depth - 1,
      profile,
      alpha,
      beta,
      again ? chainLeft - 1 : profile.chain,
    );
    if (player === me) {
      best = Math.max(best, value);
      if (best > alpha) alpha = best;
      if (alpha >= beta) break;
    } else {
      best = Math.min(best, value);
      if (best < beta) beta = best;
      if (beta <= alpha) break;
    }
  }
  return best;
}

function taste(game, player, move, fork, v2 = false) {
  const copy = cloneGame(game);
  const result = applyMove(copy, move);
  if (!result.ok) return -99999;
  if (copy.status !== "playing") return copy.winner === player ? 5000 : copy.winner === "draw" ? 0 : -5000;
  const mine = pendingCount(copy, player);
  const opp = pendingCount(copy, 1 - player);
  const gained = (result.completed + result.eaten) * 120;
  const doors = mine >= 2 ? (v2 ? 140 : 90) * fork : mine * 16;
  const danger = opp >= 2 ? (v2 ? 160 : 100) * fork : opp * (v2 ? 90 : 40);
  return gained + doors - danger;
}

/** v2 : ce coup laisse-t-il à l'autre une maison qu'il ne pouvait pas fermer avant ? */
function leavesHouse(game, player, move, before) {
  const copy = cloneGame(game);
  const result = applyMove(copy, move);
  if (!result.ok) return true;
  if (result.completed > 0 || result.eaten > 0 || copy.status !== "playing") return false;
  return pendingCount(copy, 1 - player) > before;
}

function bestImmediate(game, player, chain) {
  const found = winningMoves(game, player);
  if (!found.length) return null;
  if (!chain || found.length === 1) return found[0].move;
  let best = found[0].move;
  let bestValue = -1;
  for (const item of found.slice(0, 4)) {
    const copy = cloneGame(game);
    const result = applyMove(copy, item.move);
    const again = copy.status === "playing" && copy.current === player ? pendingCount(copy, player) : 0;
    const value = (result.completed + result.eaten) * 10 + again;
    if (value > bestValue || (value === bestValue && prefer(game, item.move, best) < 0)) {
      bestValue = value;
      best = item.move;
    }
  }
  return best;
}

function searchRoot(game, player, profile) {
  let ranked = consider(game, player, Math.max(profile.window + 4, 10));
  if (profile.v2) {
    // Ne jamais laisser une maison à l'autre quand un autre coup est possible.
    const before = pendingCount(game, 1 - player);
    const safe = ranked.filter((move) => !leavesHouse(game, player, move, before));
    if (safe.length) ranked = safe;
  }
  ranked.sort((a, b) => taste(game, player, b, profile.fork, profile.v2) - taste(game, player, a, profile.fork, profile.v2) || prefer(game, a, b));
  const window = ranked.slice(0, profile.window);
  let best = window[0];
  let bestValue = -Infinity;
  for (const move of window) {
    if (performance.now() > profile.until && best) break;
    const copy = cloneGame(game);
    const result = applyMove(copy, move);
    if (!result.ok) continue;
    const again = copy.status === "playing" && copy.current === player && (result.completed > 0 || result.eaten > 0);
    const value = search(
      copy,
      player,
      again && profile.chain > 0 ? profile.depth : profile.depth - 1,
      profile,
      -Infinity,
      Infinity,
      again ? profile.chain - 1 : profile.chain,
    );
    if (value > bestValue || (value === bestValue && prefer(game, move, best) < 0)) {
      bestValue = value;
      best = move;
    }
  }
  return best || legalMoves(game)[0] || null;
}

export function chooseMove(game, difficulty = "medium") {
  // Tous les niveaux bloquent une maison de l'autre (le nouveau Facile est l'ancien Difficile, qui bloquait).
  return chooseWith(game, PROFILE[difficulty] || PROFILE.medium, false);
}

/** Le robot v1 tel qu'il jouait à ce niveau (pour comparer la v2 à l'ancien). */
export function chooseMoveV1(game, difficulty = "medium") {
  return chooseWith(game, { ...(V1_PROFILE[difficulty] || V1_PROFILE.medium), deep: difficulty === "expert" }, difficulty === "easy");
}

function chooseWith(game, base, noBlock) {
  const moves = legalMoves(game);
  if (!moves.length || game.status !== "playing") return null;
  const profile = {
    ...base,
    nodes: 0,
    until: performance.now() + base.ms,
  };
  if (base.deep && moves.length <= 18) {
    profile.depth += 1;
    profile.window += 2;
  }
  const player = game.current;
  const win = bestImmediate(game, player, profile.depth > 1);
  if (win) return win;
  if (!noBlock) {
    const block = bestImmediate(game, 1 - player, false);
    if (block) return block;
  }
  return searchRoot(game, player, profile);
}
