/** Règles des points. Un encadrement n'existe que s'il entoure l'autre joueur. */

export const COLORS = {
  red: "#e23d3d",
  blue: "#2f6fed",
  black: "#1a1a1a",
  green: "#1f9d57",
  purple: "#7b3ff2",
  orange: "#f0741a",
};

export const COLOR_KEYS = Object.keys(COLORS);
export const PEN_STYLES = ["fine", "marker", "pencil", "fountain"];
export const THEMES = ["classic", "light"];
export const DIFFICULTIES = ["easy", "medium", "hard", "veryhard", "expert"];

export function defaultSettings() {
  return {
    rows: 20,
    cols: 17,
    extraTurn: true,
    timeMode: "none",
    timeLimit: 300,
    scoreLimit: 0,
    p1Color: "blue",
    p2Color: "red",
    penStyle: "fine",
    theme: "classic",
    difficulty: "medium",
    sound: true,
    closeMode: "auto",
    p1Name: "Joueur 1",
    p2Name: "Joueur 2",
  };
}

function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function cleanName(value, fallback) {
  const text = String(value ?? "")
    .replace(/[\u0000-\u001f]/g, "")
    .trim()
    .slice(0, 18);
  return text || fallback;
}

/** Une maison minimale occupe un bloc de 3 × 3 points. Au-delà, la feuille se remplit avant l'objectif. */
export function sheetHouseCap(rows, cols) {
  const across = Math.floor((Number(cols) + 1) / 3);
  const down = Math.floor((Number(rows) + 1) / 3);
  return Math.max(1, across * down);
}

export function normalizeSettings(input = {}) {
  const d = defaultSettings();
  const timeMode = ["none", "global", "turn"].includes(input.timeMode) ? input.timeMode : d.timeMode;
  let timeLimit = clampInt(input.timeLimit, 5, 3600, timeMode === "turn" ? 20 : 300);
  if (input.timeLimit == null) timeLimit = timeMode === "turn" ? 20 : 300;

  let p1Color = COLOR_KEYS.includes(input.p1Color) ? input.p1Color : d.p1Color;
  let p2Color = COLOR_KEYS.includes(input.p2Color) ? input.p2Color : d.p2Color;
  if (p1Color === p2Color) p2Color = COLOR_KEYS.find((key) => key !== p1Color);

  const rows = clampInt(input.rows, 2, 32, d.rows);
  const cols = clampInt(input.cols, 2, 32, d.cols);
  let scoreLimit = clampInt(input.scoreLimit, 0, 500, 0);
  const cap = sheetHouseCap(rows, cols);
  if (scoreLimit > cap) scoreLimit = cap;

  return {
    rows,
    cols,
    extraTurn: input.extraTurn !== false,
    timeMode,
    timeLimit,
    scoreLimit,
    p1Color,
    p2Color,
    penStyle: PEN_STYLES.includes(input.penStyle) ? input.penStyle : d.penStyle,
    theme: THEMES.includes(input.theme) ? input.theme : d.theme,
    difficulty: DIFFICULTIES.includes(input.difficulty) ? input.difficulty : d.difficulty,
    sound: input.sound !== false,
    closeMode: input.closeMode === "hand" ? "hand" : "auto",
    p1Name: cleanName(input.p1Name, d.p1Name),
    p2Name: cleanName(input.p2Name, d.p2Name),
  };
}

export function createGame(settings, starter = 0) {
  const s = normalizeSettings(settings);
  const rows = s.rows;
  const cols = s.cols;
  const start = starter === 1 ? 1 : 0;
  const game = {
    rows,
    cols,
    dots: Array.from({ length: rows + 1 }, () => Array(cols + 1).fill(null)),
    framed: Array.from({ length: rows + 1 }, () => Array(cols + 1).fill(null)),
    houses: [],
    scores: [0, 0],
    current: start,
    starter: start,
    status: "playing",
    winner: null,
    reason: null,
    movesPlayed: 0,
    totalDots: (rows + 1) * (cols + 1),
    settings: {
      extraTurn: s.extraTurn,
      timeMode: s.timeMode,
      timeLimit: s.timeLimit,
      scoreLimit: s.scoreLimit,
      closeMode: s.closeMode,
    },
    globalRemaining: null,
    turnRemaining: null,
    turnLimit: null,
    salt: Math.floor(Math.random() * 997),
  };
  if (s.timeMode === "global") game.globalRemaining = s.timeLimit * 1000;
  if (s.timeMode === "turn") {
    game.turnLimit = s.timeLimit * 1000;
    game.turnRemaining = game.turnLimit;
  }
  return game;
}

export function cloneGame(game) {
  return {
    ...game,
    dots: game.dots.map((row) => row.slice()),
    framed: game.framed.map((row) => row.slice()),
    houses: (game.houses || []).map((house) => ({
      ...house,
      loop: house.loop.map((dot) => ({ ...dot })),
      children: house.children.map((dot) => ({ ...dot })),
    })),
    scores: game.scores.slice(),
    settings: { ...game.settings },
  };
}

const ORTHO = [[0, 1], [1, 0], [0, -1], [-1, 0]];
const DIRS8 = [
  [0, 1],
  [1, 1],
  [1, 0],
  [1, -1],
  [0, -1],
  [-1, -1],
  [-1, 0],
  [-1, 1],
];

function outsideSeen(game, player) {
  const h = game.rows + 1;
  const w = game.cols + 1;
  const seen = Array.from({ length: h }, () => Array(w).fill(false));
  const stack = [];
  const push = (r, c) => {
    if (r < 0 || c < 0 || r >= h || c >= w || seen[r][c]) return;
    if (game.dots[r][c] === player && game.framed[r][c] == null) return;
    seen[r][c] = true;
    stack.push([r, c]);
  };
  for (let r = 0; r < h; r += 1) {
    push(r, 0);
    push(r, w - 1);
  }
  for (let c = 0; c < w; c += 1) {
    push(0, c);
    push(h - 1, c);
  }
  while (stack.length) {
    const [r, c] = stack.pop();
    push(r - 1, c);
    push(r + 1, c);
    push(r, c - 1);
    push(r, c + 1);
  }
  return { seen };
}

function interiorRegions(game, player) {
  const { seen } = outsideSeen(game, player);
  const h = game.rows + 1;
  const w = game.cols + 1;
  const used = Array.from({ length: h }, () => Array(w).fill(false));
  const regions = [];
  const blocked = (r, c) => game.dots[r][c] === player;
  for (let r = 0; r < h; r += 1) {
    for (let c = 0; c < w; c += 1) {
      if (seen[r][c] || used[r][c] || blocked(r, c)) continue;
      const cells = [];
      const captured = [];
      const stack = [[r, c]];
      used[r][c] = true;
      while (stack.length) {
        const [r0, c0] = stack.pop();
        cells.push([r0, c0]);
        const owner = game.dots[r0][c0];
        if (owner != null && owner !== player) captured.push({ r: r0, c: c0 });
        for (const [dr, dc] of ORTHO) {
          const nr = r0 + dr;
          const nc = c0 + dc;
          if (nr < 0 || nc < 0 || nr >= h || nc >= w || seen[nr][nc] || used[nr][nc] || blocked(nr, nc)) continue;
          used[nr][nc] = true;
          stack.push([nr, nc]);
        }
      }
      if (captured.length) regions.push({ cells, captured });
    }
  }
  return regions;
}

function ringOf(game, player, cells) {
  const ring = new Set();
  for (const [r, c] of cells) {
    for (let dr = -1; dr <= 1; dr += 1) {
      for (let dc = -1; dc <= 1; dc += 1) {
        if (dr === 0 && dc === 0) continue;
        const nr = r + dr;
        const nc = c + dc;
        if (nr < 0 || nc < 0 || nr > game.rows || nc > game.cols) continue;
        if (game.dots[nr][nc] === player && game.framed[nr][nc] == null) ring.add(`${nr},${nc}`);
      }
    }
  }
  return ring;
}

function traceRing(ring) {
  if (ring.size < 4) return [];
  const has = (r, c) => ring.has(`${r},${c}`);
  let sr = Infinity;
  let sc = Infinity;
  for (const item of ring) {
    const [r, c] = item.split(",").map(Number);
    if (r < sr || (r === sr && c < sc)) {
      sr = r;
      sc = c;
    }
  }
  let r = sr;
  let c = sc;
  let from = 4;
  const loop = [];
  const guard = ring.size * 8;
  for (let n = 0; n < guard; n += 1) {
    loop.push({ r, c });
    let found = -1;
    for (let turn = 1; turn <= 8; turn += 1) {
      const dir = (from + turn) % 8;
      const nr = r + DIRS8[dir][0];
      const nc = c + DIRS8[dir][1];
      if (has(nr, nc)) {
        found = dir;
        break;
      }
    }
    if (found < 0) return [];
    const nr = r + DIRS8[found][0];
    const nc = c + DIRS8[found][1];
    from = (found + 4) % 8;
    r = nr;
    c = nc;
    if (r === sr && c === sc && loop.length >= 4) return loop;
  }
  return [];
}

function angularLoop(ring, cells) {
  const dots = [...ring].map((item) => {
    const [r, c] = item.split(",").map(Number);
    return { r, c };
  });
  if (dots.length < 4) return [];
  let ar = 0;
  let ac = 0;
  for (const [r, c] of cells) {
    ar += r;
    ac += c;
  }
  ar /= cells.length;
  ac /= cells.length;
  dots.sort((a, b) => Math.atan2(a.r - ar, a.c - ac) - Math.atan2(b.r - ar, b.c - ac) || a.r - b.r || a.c - b.c);
  return dots;
}

function loopStep(a, b) {
  return Math.max(Math.abs(a.r - b.r), Math.abs(a.c - b.c));
}

function closedEnough(loop, maxStep) {
  if (!loop || loop.length < 4) return false;
  for (let i = 0; i < loop.length; i += 1) {
    const step = loopStep(loop[i], loop[(i + 1) % loop.length]);
    if (step < 1 || step > maxStep) return false;
  }
  return true;
}

function holdsInside(loop, cells) {
  return cells.some(([r, c]) => strictlyInside(loop, r, c));
}

function pruneSpurs(ring) {
  const set = new Set(ring);
  let changed = true;
  while (changed) {
    changed = false;
    for (const key of [...set]) {
      const [r, c] = key.split(",").map(Number);
      let neighbors = 0;
      for (let dr = -1; dr <= 1; dr += 1) {
        for (let dc = -1; dc <= 1; dc += 1) {
          if (!dr && !dc) continue;
          if (set.has(`${r + dr},${c + dc}`)) neighbors += 1;
        }
      }
      if (neighbors < 2) {
        set.delete(key);
        changed = true;
      }
    }
  }
  return set;
}

function loopAround(game, player, cells) {
  const ring = pruneSpurs(ringOf(game, player, cells));
  const traced = traceRing(ring);
  if (attachedLoop(traced) && holdsInside(traced, cells)) return traced;
  const around = angularLoop(ring, cells);
  if (closedEnough(around, 1) && holdsInside(around, cells)) return around;
  return [];
}

function attachedLoop(loop) {
  if (!loop || loop.length < 4) return false;
  for (let i = 0; i < loop.length; i += 1) {
    const a = loop[i];
    const b = loop[(i + 1) % loop.length];
    const dr = Math.abs(a.r - b.r);
    const dc = Math.abs(a.c - b.c);
    if (dr > 1 || dc > 1 || (dr === 0 && dc === 0)) return false;
  }
  return true;
}

function houseKey(dots) {
  return dots.map((dot) => `${dot.r},${dot.c}`).sort().join("|");
}

function kidsInside(game, player, loop) {
  const kids = [];
  for (let r = 0; r <= game.rows; r += 1) {
    for (let c = 0; c <= game.cols; c += 1) {
      if (!strictlyInside(loop, r, c)) continue;
      const color = game.dots[r][c];
      if (color == null || color === player) continue;
      kids.push({ r, c });
    }
  }
  return kids;
}

/** Les cadres que ce joueur peut tracer pour manger. Rien d'autre n'est visé. */
export function catchLoops(game, player) {
  if (!game || game.status !== "playing") return [];
  const found = newHouses(game, player).map((house) => house.loop);
  if (found.length) return found;
  const { seen } = outsideSeen(game, player);
  const loops = [];
  for (const old of game.houses || []) {
    if (!old.alive || old.owner === player || !old.loop?.length) continue;
    if (!old.loop.every((dot) => seen[dot.r][dot.c] !== true)) continue;
    const cells = old.loop.map((dot) => [dot.r, dot.c]);
    for (const dot of old.children || []) cells.push([dot.r, dot.c]);
    const loop = loopAround(game, player, cells);
    if (loop.length >= 4) loops.push(loop);
  }
  return loops;
}

/** Vrai si ce joueur peut encore manger : une maison neuve, ou celle de l'autre déjà contournée. */
export function canCatch(game, player) {
  return catchLoops(game, player).length > 0;
}

function newHouses(game, player) {
  const found = [];
  const seen = new Set((game.houses || []).filter((house) => house.alive && house.owner === player).map((house) => house.key));
  for (const region of interiorRegions(game, player)) {
    const loop = loopAround(game, player, region.cells);
    if (loop.length < 4) continue;
    if (loop.some((dot) => game.dots[dot.r][dot.c] !== player || game.framed[dot.r][dot.c] != null)) continue;
    const children = region.captured.length ? region.captured.slice() : kidsInside(game, player, loop);
    if (!children.length) continue;
    const key = houseKey(children);
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({
      loop,
      children,
      key,
      cells: region.cells.map(([r, c]) => ({ r, c })),
    });
  }
  return found;
}

function sealCell(game, player, r, c) {
  if (game.framed[r][c] != null) return;
  if (game.dots[r][c] === player) return;
  game.framed[r][c] = player;
}

function sealHouse(game, player, house) {
  for (const cell of house.cells || []) sealCell(game, player, cell.r, cell.c);
  for (const kid of house.children) sealCell(game, player, kid.r, kid.c);
}

function swallowHouses(game, player) {
  const { seen } = outsideSeen(game, player);
  let eaten = 0;
  for (const old of game.houses) {
    if (!old.alive || old.owner === player || !old.loop.length) continue;
    const covered = old.loop.every((dot) => seen[dot.r][dot.c] !== true);
    if (!covered) continue;
    old.alive = false;
    game.scores[old.owner] = Math.max(0, game.scores[old.owner] - 1);
    eaten += 1;
    for (const dot of old.loop) game.framed[dot.r][dot.c] = player;
    for (const kid of old.children) game.framed[kid.r][kid.c] = player;
  }
  return eaten;
}
export function enclosures(game) {
  if (!game?.houses) return [];
  return game.houses.map((house) => ({
    player: house.owner,
    loop: house.loop,
    captured: house.children,
    alive: house.alive,
  }));
}

function strictlyInside(loop, r, c) {
  for (const dot of loop) {
    if (dot.r === r && dot.c === c) return false;
  }
  let inside = false;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i, i += 1) {
    const yi = loop[i].r;
    const yj = loop[j].r;
    const xi = loop[i].c;
    const xj = loop[j].c;
    const crosses = (yi > r) !== (yj > r);
    if (!crosses) continue;
    const xAt = ((xj - xi) * (r - yi)) / (yj - yi) + xi;
    if (c < xAt) inside = !inside;
  }
  return inside;
}

export function dotIsOpen(game, move) {
  if (!move) return false;
  const r = move.r;
  const c = move.c;
  if (!Number.isInteger(r) || !Number.isInteger(c)) return false;
  if (r < 0 || r > game.rows || c < 0 || c > game.cols) return false;
  if (game.framed[r][c] != null) return false;
  return game.dots[r][c] == null;
}

/** Ce que produirait ce point, sans modifier la partie. */
export function moveInfo(game, move) {
  if (!dotIsOpen(game, move)) return { ok: false, completes: 0, givesThird: false, opens: 0 };
  const player = game.current;
  game.dots[move.r][move.c] = player;
  const completes = newHouses(game, player).length;
  game.dots[move.r][move.c] = null;
  return { ok: true, completes, givesThird: false, opens: 0 };
}

export function legalMoves(game) {
  const moves = [];
  for (let r = 0; r <= game.rows; r += 1) {
    for (let c = 0; c <= game.cols; c += 1) {
      if (dotIsOpen(game, { r, c })) moves.push({ r, c });
    }
  }
  return moves;
}

function finish(game, winner, reason) {
  game.status = "finished";
  game.winner = winner;
  game.reason = reason;
}

function finishByScore(game) {
  if (game.scores[0] > game.scores[1]) finish(game, 0, "board");
  else if (game.scores[1] > game.scores[0]) finish(game, 1, "board");
  else finish(game, "draw", "board");
}

function resetTurnClock(game) {
  if (game.settings.timeMode === "turn") game.turnRemaining = game.turnLimit;
}

/**
 * Pose un pointillé. Une maison fermée vaut 1 point, quel que soit le nombre d'enfants dedans.
 * Un enfant déjà mangé ne sert plus de lien. Contourner une maison retire son point.
 */
export function applyMove(game, move, options = {}) {
  if (!game || game.status !== "playing" || !dotIsOpen(game, move)) {
    return { ok: false, completed: 0, captured: [], eaten: 0, player: null };
  }
  const player = game.current;
  game.dots[move.r][move.c] = player;

  const manual = options.autoClose === false;
  const houses = manual ? [] : newHouses(game, player);
  for (const house of houses) {
    game.houses.push({
      owner: player,
      loop: house.loop,
      children: house.children,
      key: house.key,
      alive: true,
    });
    game.scores[player] += 1;
    sealHouse(game, player, house);
  }
  const eaten = manual ? 0 : swallowHouses(game, player);
  if (!houses.length && eaten > 0) game.scores[player] += eaten;
  game.movesPlayed += 1;
  const pending = manual && canCatch(game, player);

  const limit = game.settings.scoreLimit;
  if (limit > 0 && game.scores[player] >= limit) {
    finish(game, player, "score");
  } else if (!pending && (legalMoves(game).length === 0 || game.movesPlayed >= game.totalDots)) {
    finishByScore(game);
  } else if (pending || ((houses.length > 0 || eaten > 0) && game.settings.extraTurn)) {
    resetTurnClock(game);
  } else {
    game.current = 1 - player;
    resetTurnClock(game);
  }
  return { ok: true, completed: houses.length, captured: houses, eaten, pending, player };
}

/** Le joueur trace lui-même le cadre, une case à la fois, sur ses propres pointillés. */
export function closeByHand(game, loop) {
  if (!game || game.status !== "playing") return { ok: false, reason: "La partie est finie." };
  const player = game.current;
  const clean = (loop || []).map((dot) => ({ r: dot.r, c: dot.c }));
  if (!attachedLoop(clean)) return { ok: false, reason: "Le trait dépasse une case ou ne ferme pas." };
  for (const dot of clean) {
    if (game.dots[dot.r]?.[dot.c] !== player || game.framed[dot.r][dot.c] != null) {
      return { ok: false, reason: "Suivez vos pointillés, sans dépasser les cases." };
    }
  }
  const children = kidsInside(game, player, clean);
  if (!children.length) return { ok: false, reason: "Aucun enfant dans ce cadre." };
  const key = houseKey(children);
  if ((game.houses || []).some((house) => house.alive && house.owner === player && house.key === key)) {
    return { ok: false, reason: "Cette maison est déjà prise." };
  }
  const cells = [];
  for (let r = 0; r <= game.rows; r += 1) {
    for (let c = 0; c <= game.cols; c += 1) {
      if (strictlyInside(clean, r, c)) cells.push({ r, c });
    }
  }
  const house = { loop: clean, children, key, cells };
  game.houses.push({
    owner: player,
    loop: clean,
    children,
    key,
    cells,
    alive: true,
  });
  game.scores[player] += 1;
  sealHouse(game, player, house);
  const eaten = swallowHouses(game, player);
  const limit = game.settings.scoreLimit;
  if (limit > 0 && game.scores[player] >= limit) finish(game, player, "score");
  else if (legalMoves(game).length === 0 || game.movesPlayed >= game.totalDots) finishByScore(game);
  else if (game.settings.extraTurn) resetTurnClock(game);
  else {
    game.current = 1 - player;
    resetTurnClock(game);
  }
  return { ok: true, completed: 1, eaten, player };
}

export function abandon(game, playerIndex) {
  if (!game || game.status !== "playing") return;
  if (playerIndex !== 0 && playerIndex !== 1) return;
  finish(game, 1 - playerIndex, "abandon");
}

/** Avance les horloges. `dt` est en millisecondes. */
export function tick(game, dt) {
  if (!game || game.status !== "playing" || !(dt > 0)) return { timedOut: false };
  if (game.settings.timeMode === "global" && game.globalRemaining != null) {
    const before = game.globalRemaining;
    game.globalRemaining = Math.max(0, before - dt);
    if (before > 0 && game.globalRemaining === 0) {
      if (game.scores[0] > game.scores[1]) finish(game, 0, "time");
      else if (game.scores[1] > game.scores[0]) finish(game, 1, "time");
      else finish(game, "draw", "time");
      return { timedOut: true, kind: "global" };
    }
  }
  if (game.settings.timeMode === "turn" && game.turnRemaining != null) {
    const before = game.turnRemaining;
    game.turnRemaining = Math.max(0, before - dt);
    if (before > 0 && game.turnRemaining === 0) return { timedOut: true, kind: "turn" };
  }
  return { timedOut: false };
}

export function formatClock(ms) {
  const total = Math.max(0, Math.ceil((ms ?? 0) / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function makeRoomCode(reserved) {
  for (let i = 0; i < 20; i += 1) {
    const code = `EGD-${Math.floor(1000 + Math.random() * 9000)}`;
    if (!reserved.has(code)) return code;
  }
  return `EGD-${Date.now() % 10000}`;
}
