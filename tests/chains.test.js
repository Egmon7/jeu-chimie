import { applyMove, createGame, normalizeSettings } from "../public/js/engine.js";

// Rigueur sur les chaînes : toute chaîne fermée doit prendre les points enfermés, les dessiner en maison,
// et le score doit toujours égaler la valeur des maisons vivantes.

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

const ORTHO = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const ALL8 = [...ORTHO, [1, 1], [1, -1], [-1, 1], [-1, -1]];

function houseValue(game, player) {
  return game.houses.filter((h) => h.alive && h.owner === player).reduce((sum, h) => sum + (h.value || 1), 0);
}

function inDrawnHouse(game, player, r, c) {
  return game.houses.some((h) => h.alive && h.owner === player && h.children.some((k) => k.r === r && k.c === c));
}

// 1) Position relevée sur une vraie partie : Noir entoure deux maisons bleues avec un grand anneau irrégulier.
//    Avant la correction, Noir marquait les points sans qu'aucune maison ne soit dessinée.
{
  const BLACK = 1;
  const BLUE = 0;
  const rows = [
    [0, [10, 11], [12, 13]],
    [1, [8, 9, 10, 12, 13], [11]],
    [2, [7, 12], [8, 9, 10, 11]],
    [3, [5, 6, 13], [7, 8, 11, 12]],
    [4, [3, 5, 7, 12, 13], [6, 8, 9, 10, 11]],
    [5, [2, 3, 4, 7, 9, 10, 11, 13], [5, 8, 12, 14, 15]],
    [6, [0, 1, 3, 11, 14], [2, 4, 8, 9, 10, 13]],
    [7, [0, 4, 10, 11, 14], [1, 2, 5, 7, 8, 9, 12]],
    [8, [0, 1, 5, 8, 12, 13], [2, 3, 4, 6, 7, 9, 10, 11]],
    [9, [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13], [0, 1, 12]],
    [10, [1, 2, 10], [11, 12, 13]],
  ];
  const O = 2;
  const inside = new Set(["4,7", "5,7", "5,9", "5,10", "5,11", "6,11", "7,10", "7,11", "8,8"]);
  const black = [];
  const blue = [];
  for (const [r, bs, us] of rows) {
    for (const c of bs) black.push([r, c]);
    for (const c of us) blue.push([r, c]);
  }
  const game = createGame(normalizeSettings({ rows: 16, cols: 20 }), 0);
  const play = (player, [r, c]) => {
    game.current = player;
    return applyMove(game, { r: r + O, c: c + O });
  };
  for (const dot of black.filter(([r, c]) => inside.has(`${r},${c}`))) play(BLACK, dot);
  for (const dot of blue) play(BLUE, dot);
  assert(game.houses.filter((h) => h.owner === BLUE && h.alive).length === 2, "capture : Bleu a 2 maisons");
  for (const dot of black.filter(([r, c]) => !inside.has(`${r},${c}`))) play(BLACK, dot);
  assert(game.houses.filter((h) => h.owner === BLUE && h.alive).length === 0, "capture : les maisons bleues sont mangées");
  assert(game.scores[BLACK] === 3 && game.scores[BLUE] === 0, "capture : Noir a 3 points (1 maison + 2 mangées)");
  assert(houseValue(game, BLACK) === game.scores[BLACK], "capture : chaque point de Noir a sa maison dessinée");
  const big = game.houses.find((h) => h.alive && h.owner === BLACK && (h.value || 1) === 2);
  assert(big && big.loop.length >= 20, "capture : la maison de Noir suit son anneau autour des maisons bleues");
}

// 2) Banc d'essai : des centaines de chaînes de formes variées, tirage fixe pour être rejouable.
{
  let seed = 20261123;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const shuffle = (list) => {
    for (let i = list.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rand() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
    return list;
  };
  const SIZE = 14;
  const blob = (size) => {
    const r0 = 3 + Math.floor(rand() * (SIZE - 6));
    const c0 = 3 + Math.floor(rand() * (SIZE - 6));
    const cells = new Set([`${r0},${c0}`]);
    for (let guard = 0; cells.size < size && guard < 500; guard += 1) {
      const [r, c] = pick([...cells]).split(",").map(Number);
      const [dr, dc] = pick(ORTHO);
      if (r + dr < 2 || c + dc < 2 || r + dr > SIZE - 2 || c + dc > SIZE - 2) continue;
      cells.add(`${r + dr},${c + dc}`);
    }
    const seen = new Set();
    const stack = [];
    for (let i = 0; i <= SIZE; i += 1) stack.push([i, 0], [i, SIZE], [0, i], [SIZE, i]);
    while (stack.length) {
      const [r, c] = stack.pop();
      const key = `${r},${c}`;
      if (r < 0 || c < 0 || r > SIZE || c > SIZE || seen.has(key) || cells.has(key)) continue;
      seen.add(key);
      for (const [dr, dc] of ORTHO) stack.push([r + dr, c + dc]);
    }
    for (let r = 0; r <= SIZE; r += 1) for (let c = 0; c <= SIZE; c += 1) if (!seen.has(`${r},${c}`)) cells.add(`${r},${c}`);
    return cells;
  };
  const ringOf = (cells, dirs) => {
    const out = new Set();
    for (const key of cells) {
      const [r, c] = key.split(",").map(Number);
      for (const [dr, dc] of dirs) if (!cells.has(`${r + dr},${c + dc}`)) out.add(`${r + dr},${c + dc}`);
    }
    return out;
  };
  const variants = ["simple", "large", "dedans", "maisons", "complexe", "melange"];
  for (let trial = 0; trial < 360; trial += 1) {
    const variant = variants[trial % variants.length];
    const cells = blob(1 + Math.floor(rand() * 16));
    const zone = new Set(cells);
    if (variant !== "simple" && variant !== "dedans" && variant !== "melange") for (const k of ringOf(cells, ALL8)) zone.add(k);
    const wall = [...ringOf(zone, rand() < 0.5 ? ALL8 : ORTHO)].map((k) => k.split(",").map(Number));
    const inner = [...cells].map((k) => k.split(",").map(Number));
    const kids = shuffle(inner.slice()).slice(0, 1 + Math.floor(rand() * inner.length));
    const game = createGame(normalizeSettings({ rows: SIZE, cols: SIZE }), 0);
    const put = (player, r, c) => {
      if (game.dots[r]?.[c] !== null || game.framed[r][c] != null) return;
      game.current = player;
      applyMove(game, { r, c });
    };
    if (variant === "maisons" || variant === "complexe") {
      const spots = shuffle(inner.slice()).slice(0, 2 + Math.floor(rand() * 3));
      for (const [r, c] of spots) put(0, r, c);
      for (const [r, c] of spots) for (const [dr, dc] of ORTHO) put(1, r + dr, c + dc);
      if (variant === "complexe") {
        const edge = [...zone].map((k) => k.split(",").map(Number)).filter(([r, c]) => !cells.has(`${r},${c}`));
        for (const [r, c] of shuffle(edge).slice(0, 3)) put(0, r, c);
      }
    }
    if (variant === "dedans") for (const [r, c] of shuffle(inner.slice()).slice(0, 2)) put(0, r, c);
    const order = shuffle(wall.slice());
    if (variant === "melange") {
      const steps = shuffle([...order.map((d) => [0, d]), ...kids.map((d) => [1, d])]);
      for (const [who, [r, c]] of steps) put(who, r, c);
    } else {
      for (const [r, c] of kids) put(1, r, c);
      for (const [r, c] of order) put(0, r, c);
    }
    put(0, 0, 0);
    const enclosed = [...zone].map((k) => k.split(",").map(Number)).filter(([r, c]) => game.dots[r][c] === 1);
    for (const [r, c] of enclosed) {
      assert(game.framed[r][c] === 0, `chaîne ${trial} (${variant}) : le point ${r},${c} enfermé n'est pas pris`);
      assert(inDrawnHouse(game, 0, r, c), `chaîne ${trial} (${variant}) : le point ${r},${c} est pris sans maison dessinée`);
    }
    assert(houseValue(game, 0) === game.scores[0], `chaîne ${trial} (${variant}) : score ${game.scores[0]} ≠ maisons ${houseValue(game, 0)}`);
  }
}

console.log("chains ok");
