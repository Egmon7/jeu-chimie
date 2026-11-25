import { createGame, applyMove } from "../public/js/engine.js";

/** Comptes suivis pour la collecte : nom affiché à l'admin et clé sans accents ni majuscules. */
export const LEARN_PEOPLE = [
  { key: "ntotimbe", label: "Ntotimbe" },
  { key: "h20", label: "H20" },
  { key: "beni mbuyi", label: "Béni Mbuyi" },
  { key: "joel mifuba", label: "Joel mifuba" },
];
export const LEARN_NAMES = LEARN_PEOPLE.map((person) => person.key);

/** « Béni  Mbuyi » → « beni mbuyi » : même règle que la recherche en base. */
export function learnNameKey(name) {
  return String(name || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

export function packGrid(grid) {
  return grid.map((row) => row.map((cell) => (cell == null ? "-" : String(cell))).join("")).join("/");
}

export function unpackGrid(pack, rows, cols) {
  const lines = String(pack || "").split("/");
  return Array.from({ length: rows + 1 }, (_, r) => {
    const line = lines[r] || "";
    return Array.from({ length: cols + 1 }, (_, c) => {
      const ch = line[c];
      if (ch === "0") return 0;
      if (ch === "1") return 1;
      return null;
    });
  });
}

export function boardSnap(game) {
  if (!game) return null;
  return {
    rows: game.rows,
    cols: game.cols,
    dots: packGrid(game.dots),
    framed: packGrid(game.framed),
    scores: [Number(game.scores[0]) || 0, Number(game.scores[1]) || 0],
    current: game.current,
    status: game.status,
    winner: game.winner,
    movesPlayed: game.movesPlayed,
  };
}

/** Version des règles d'analyse : quand elle change, les parties déjà gardées sont relues. */
export const LEARN_ANALYSIS_VERSION = 2;

/** Une feuille complète tous les CHECKPOINT coups suffit : le reste se reconstruit en rejouant. */
export const LEARN_CHECKPOINT = 50;

export function learnFingerprint(player0, player1, startedAt, rows, cols) {
  const pair = [String(player0), String(player1)].sort().join(":");
  return `${pair}|${Number(startedAt) || 0}|${Number(rows) || 0}x${Number(cols) || 0}`;
}

/** Rejoue la partie à partir des coups. Renvoie le jeu final. */
export function replayLearnMoves(settings, starter, moves) {
  const game = createGame(settings || {}, starter === 1 ? 1 : 0);
  for (const step of moves || []) {
    if (step.seat === 0 || step.seat === 1) game.current = step.seat;
    const result = applyMove(game, { r: Number(step.r), c: Number(step.c) });
    if (!result.ok) {
      const err = new Error(`Coup ${step.step ?? "?"} impossible.`);
      err.code = "replay";
      throw err;
    }
  }
  return game;
}

export function sameSnapScores(snap, game) {
  if (!snap || !game) return false;
  return Number(snap.scores?.[0]) === Number(game.scores[0])
    && Number(snap.scores?.[1]) === Number(game.scores[1]);
}
