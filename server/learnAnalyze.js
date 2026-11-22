import { applyMove, createGame } from "../public/js/engine.js";
import { unpackGrid } from "./learn.js";

function seatOutcome(seat, winner) {
  if (winner === "draw" || winner == null || winner === "") return "draw";
  const w = Number(winner);
  if (w !== 0 && w !== 1) return "draw";
  return w === seat ? "win" : "loss";
}

function pushUnique(list, item) {
  if (list.some((row) => row.kind === item.kind && row.step === item.step && row.seat === item.seat)) return;
  list.push(item);
}

function openFromSnap(snap) {
  if (!snap?.dots) return null;
  const rows = Number(snap.rows) || 0;
  const cols = Number(snap.cols) || 0;
  const dots = unpackGrid(snap.dots, rows, cols);
  const framed = unpackGrid(snap.framed, rows, cols);
  let n = 0;
  for (let r = 0; r <= rows; r += 1) {
    for (let c = 0; c <= cols; c += 1) {
      if (dots[r][c] == null && framed[r][c] == null) n += 1;
    }
  }
  return n;
}

function totalFromSnap(snap) {
  if (!snap) return 0;
  return (Number(snap.rows) + 1) * (Number(snap.cols) + 1);
}

function gainedFromSnaps(move) {
  const seat = move.seat === 1 ? 1 : 0;
  const before = Number(move.before?.scores?.[seat]);
  const after = Number(move.after?.scores?.[seat]);
  if (Number.isFinite(before) && Number.isFinite(after)) return Math.max(0, after - before);
  return null;
}

/**
 * Lit une partie gardée et n’en tire que ce qui apparaît vraiment dans les coups.
 * Aucune situation inventée si la partie est vide.
 */
export function analyzeLearnMatch(match) {
  const situations = [];
  const moves = match?.moves;
  if (!Array.isArray(moves) || !moves.length) return situations;

  const winner = match.winner;
  const timeline = [];
  let chain = null;

  const flushChain = () => {
    if (!chain || chain.length < 1) {
      chain = null;
      return;
    }
    pushUnique(situations, {
      step: chain.start,
      kind: chain.length >= 3 ? "chain_long" : "chain_short",
      seat: chain.seat,
      outcome: seatOutcome(chain.seat, winner),
      size: chain.length,
      detail: { gained: chain.gained, endStep: chain.end },
    });
    chain = null;
  };

  // Préfère les feuilles stockées ; sinon rejoue depuis le début.
  let game = null;
  const canSnap = moves.every((move) => move?.before?.scores && move?.after?.scores);
  if (!canSnap) {
    const settings = {
      ...(match.settings && typeof match.settings === "object" ? match.settings : {}),
      rows: match.rows ?? match.settings?.rows,
      cols: match.cols ?? match.settings?.cols,
    };
    game = createGame(settings, match.starter === 1 ? 1 : 0);
  }

  for (const move of moves) {
    const step = Number.isInteger(move.step) ? move.step : timeline.length;
    let seat = move.seat === 1 ? 1 : 0;
    let gained = gainedFromSnaps(move);
    let openBefore = openFromSnap(move.before);
    let total = totalFromSnap(move.before) || ((Number(match.rows) + 1) * (Number(match.cols) + 1));

    if (gained == null && game) {
      if (game.status !== "playing") break;
      if (move.seat === 0 || move.seat === 1) game.current = move.seat;
      seat = game.current;
      openBefore = 0;
      for (let r = 0; r <= game.rows; r += 1) {
        for (let c = 0; c <= game.cols; c += 1) {
          if (game.dots[r][c] == null && game.framed[r][c] == null) openBefore += 1;
        }
      }
      total = game.totalDots;
      const result = applyMove(game, { r: Number(move.r), c: Number(move.c) });
      if (!result.ok) break;
      gained = (Number(result.completed) || 0) + (Number(result.eaten) || 0);
    }
    if (gained == null) continue;

    timeline.push({ step, seat, gained, r: move.r, c: move.c });
    const endgame = openBefore != null && openBefore <= Math.max(6, Math.floor(total * 0.22));
    if (endgame) {
      pushUnique(situations, {
        step,
        kind: "endgame",
        seat,
        outcome: seatOutcome(seat, winner),
        size: openBefore,
        detail: { open: openBefore, gained },
      });
    }

    if (gained > 0) {
      if (chain && chain.seat === seat) {
        chain.length += 1;
        chain.gained += gained;
        chain.end = step;
      } else {
        flushChain();
        chain = { seat, start: step, end: step, length: 1, gained };
      }
      const nextSeat = move.after?.current ?? (game ? game.current : null);
      if (nextSeat != null && Number(nextSeat) !== seat) flushChain();
    } else {
      flushChain();
    }
  }
  flushChain();

  for (const item of patternsFromTimeline(timeline, winner)) pushUnique(situations, item);
  return situations;
}

/** Patterns lus sur une timeline réelle de coups (rien d’inventé). */
export function patternsFromTimeline(timeline, winner) {
  const found = [];
  for (let i = 0; i < timeline.length; i += 1) {
    const start = timeline[i];
    if (start.gained > 0) continue;
    let j = i + 1;
    let oppGain = 0;
    let oppSteps = 0;
    while (j < timeline.length && timeline[j].seat === 1 - start.seat) {
      oppGain += timeline[j].gained;
      oppSteps += 1;
      j += 1;
      if (oppSteps > 8) break;
    }
    if (oppGain < 1) continue;
    let selfGain = 0;
    let selfSteps = 0;
    const selfStart = j < timeline.length ? timeline[j].step : start.step;
    while (j < timeline.length && timeline[j].seat === start.seat) {
      selfGain += timeline[j].gained;
      selfSteps += 1;
      j += 1;
      if (selfSteps > 12) break;
    }
    if (selfGain <= oppGain) continue;
    const outcome = seatOutcome(start.seat, winner);
    if (oppGain === 1 && selfGain >= 2) {
      found.push({
        step: start.step,
        kind: "double_cross",
        seat: start.seat,
        outcome,
        size: selfGain,
        detail: { oppGain, selfGain, replyStep: selfStart },
      });
    } else {
      found.push({
        step: start.step,
        kind: "sacrifice",
        seat: start.seat,
        outcome,
        size: selfGain - oppGain,
        detail: { oppGain, selfGain, replyStep: selfStart },
      });
    }
  }
  return found;
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
