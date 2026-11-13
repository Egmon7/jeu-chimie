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
export const DIFFICULTIES = ["easy", "medium", "hard", "expert"];

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

export function normalizeSettings(input = {}) {
  const d = defaultSettings();
  const timeMode = ["none", "global", "turn"].includes(input.timeMode) ? input.timeMode : d.timeMode;
  let timeLimit = clampInt(input.timeLimit, 5, 3600, timeMode === "turn" ? 20 : 300);
  if (input.timeLimit == null) timeLimit = timeMode === "turn" ? 20 : 300;

  let p1Color = COLOR_KEYS.includes(input.p1Color) ? input.p1Color : d.p1Color;
  let p2Color = COLOR_KEYS.includes(input.p2Color) ? input.p2Color : d.p2Color;
  if (p1Color === p2Color) p2Color = COLOR_KEYS.find((key) => key !== p1Color);

  return {
    rows: clampInt(input.rows, 2, 32, d.rows),
    cols: clampInt(input.cols, 2, 32, d.cols),
    extraTurn: input.extraTurn !== false,
    timeMode,
    timeLimit,
    scoreLimit: clampInt(input.scoreLimit, 0, 500, 0),
    p1Color,
    p2Color,
    penStyle: PEN_STYLES.includes(input.penStyle) ? input.penStyle : d.penStyle,
    theme: THEMES.includes(input.theme) ? input.theme : d.theme,
    difficulty: DIFFICULTIES.includes(input.difficulty) ? input.difficulty : d.difficulty,
    sound: input.sound !== false,
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
    },
    globalRemaining: null,
    turnRemaining: null,
    turnLimit: null,
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
  return seen;
}

function interiorRegions(game, player) {
  const seen = outsideSeen(game, player);
  const h = game.rows + 1;
  const w = game.cols + 1;
  const used = Array.from({ length: h }, () => Array(w).fill(false));
  const regions = [];
  for (let r = 0; r < h; r += 1) {
    for (let c = 0; c < w; c += 1) {
      if (seen[r][c] || used[r][c] || game.dots[r][c] === player) continue;
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
          if (nr < 0 || nc < 0 || nr >= h || nc >= w || seen[nr][nc] || used[nr][nc]) continue;
          if (game.dots[nr][nc] === player) continue;
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

function traceMixed(ring) {
  if (ring.size < 4) return [];
  let sr = Infinity;
  let sc = Infinity;
  for (const item of ring) {
    const [r, c] = item.split(",").map(Number);
    if (r < sr || (r === sr && c < sc)) {
      sr = r;
      sc = c;
    }
  }
  const has = (r, c) => ring.has(`${r},${c}`);
  let r = sr;
  let c = sc;
  let incoming = 6;
  const loop = [];
  const guard = ring.size * 8;
  for (let n = 0; n < guard; n += 1) {
    loop.push({ r, c });
    const ortho = [];
    const diag = [];
    for (let dir = 0; dir < 8; dir += 1) {
      const nr = r + DIRS8[dir][0];
      const nc = c + DIRS8[dir][1];
      if (!has(nr, nc)) continue;
      if (n > 0) {
        const backR = r - DIRS8[incoming][0];
        const backC = c - DIRS8[incoming][1];
        if (nr === backR && nc === backC) continue;
      }
      if (dir % 2 === 0) ortho.push(dir);
      else diag.push(dir);
    }
    let pool = ortho.length ? ortho : diag;
    if (!pool.length && n > 0) {
      const backDir = (incoming + 4) % 8;
      if (has(r + DIRS8[backDir][0], c + DIRS8[backDir][1])) pool = [backDir];
    }
    if (!pool.length) return [];
    let chosen = null;
    for (let turn = 1; turn <= 8; turn += 1) {
      const dir = (incoming + turn) % 8;
      if (pool.includes(dir)) {
        chosen = dir;
        break;
      }
    }
    if (chosen == null) return [];
    incoming = chosen;
    r += DIRS8[chosen][0];
    c += DIRS8[chosen][1];
    if (r === sr && c === sc && loop.length >= 4) return loop;
  }
  return [];
}

function loopAround(game, player, cells) {
  return traceMixed(ringOf(game, player, cells));
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

function newHouses(game, player) {
  const found = [];
  const seen = new Set((game.houses || []).filter((house) => house.alive && house.owner === player).map((house) => house.key));
  for (const region of interiorRegions(game, player)) {
    const loop = loopAround(game, player, region.cells);
    if (!attachedLoop(loop)) continue;
    if (loop.some((dot) => game.dots[dot.r][dot.c] !== player || game.framed[dot.r][dot.c] != null)) continue;
    const children = region.captured.length ? region.captured.slice() : kidsInside(game, player, loop);
    if (!children.length) continue;
    const key = houseKey(children);
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({ loop, children, key });
  }
  return found;
}

function swallowHouses(game, player) {
  const seen = outsideSeen(game, player);
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
      if (game.dots[r][c] == null) moves.push({ r, c });
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
export function applyMove(game, move) {
  if (!game || game.status !== "playing" || !dotIsOpen(game, move)) {
    return { ok: false, completed: 0, captured: [], eaten: 0, player: null };
  }
  const player = game.current;
  game.dots[move.r][move.c] = player;

  const houses = newHouses(game, player);
  for (const house of houses) {
    game.houses.push({
      owner: player,
      loop: house.loop,
      children: house.children,
      key: house.key,
      alive: true,
    });
    game.scores[player] += 1;
    for (const kid of house.children) {
      if (game.framed[kid.r][kid.c] == null) game.framed[kid.r][kid.c] = player;
    }
  }
  const eaten = swallowHouses(game, player);
  if (!houses.length && eaten > 0) game.scores[player] += eaten;
  game.movesPlayed += 1;

  const limit = game.settings.scoreLimit;
  if (limit > 0 && game.scores[player] >= limit) {
    finish(game, player, "score");
  } else if (game.movesPlayed >= game.totalDots) {
    finishByScore(game);
  } else if ((houses.length > 0 || eaten > 0) && game.settings.extraTurn) {
    resetTurnClock(game);
  } else {
    game.current = 1 - player;
    resetTurnClock(game);
  }
  return { ok: true, completed: houses.length, captured: houses, eaten, player };
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
