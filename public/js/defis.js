/**
 * Défis du jour et de la semaine.
 * Le tirage est le même pour tout le monde (heure de Paris) : chaque jour à minuit, chaque semaine le lundi.
 * Chaque défi se mesure à partir des parties enregistrées, rien d'inventé.
 * Un tirage contient toujours un défi « Jusqu'au bout » (finir ses parties sans abandonner).
 */

const LEVELS = ["easy", "medium", "hard", "veryhard", "expert"];
const atLeast = (game, level) => LEVELS.indexOf(game.difficulty) >= LEVELS.indexOf(level);

/** Les parties où le joueur avait une place : contre le robot ou en ligne. */
export function ownGames(games) {
  return (games || []).filter((game) =>
    (game.mode === "solo" || game.mode === "online") && (game.userSeat === 0 || game.userSeat === 1));
}

const seatOf = (game) => Number(game.userSeat) || 0;
const scoreOf = (game, seat) => {
  const value = Array.isArray(game.scores) ? game.scores[seat] : game.scores?.[seat];
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};
const mine = (game) => scoreOf(game, seatOf(game));
const theirs = (game) => scoreOf(game, 1 - seatOf(game));
const won = (game) => String(game.winner) === String(seatOf(game));
/** Le joueur a abandonné : la partie finit par abandon et il ne l'a pas gagnée. */
const quit = (game) => game.reason === "abandon" && !won(game);
const finished = (game) => !quit(game);
const solo = (game) => game.mode === "solo";
const online = (game) => game.mode === "online";
const count = (test) => (games) => games.filter(test).length;
const sum = (value) => (games) => games.reduce((total, game) => total + value(game), 0);

function bestWinRun(games) {
  let best = 0;
  let run = 0;
  for (const game of [...games].sort((a, b) => a.at - b.at)) {
    run = won(game) ? run + 1 : 0;
    best = Math.max(best, run);
  }
  return best;
}

export const DAILY = [
  { id: "j_finir2", anti: true, name: "Finir ce qu’on commence", text: "Finir 2 parties sans abandonner.", goal: 2, xp: 30, measure: count(finished) },
  { id: "j_finir3", anti: true, name: "Sans lâcher", text: "Finir 3 parties sans abandonner.", goal: 3, xp: 40, measure: count(finished) },
  { id: "j_finir_dur", anti: true, name: "Tenir tête", text: "Finir une partie contre Difficile ou plus, sans abandonner.", goal: 1, xp: 35, measure: count((g) => solo(g) && atLeast(g, "hard") && finished(g)) },
  { id: "j_jouer3", name: "Échauffement", text: "Jouer 3 parties.", goal: 3, xp: 20, measure: count(() => true) },
  { id: "j_gagner1", name: "Victoire du jour", text: "Gagner 1 partie.", goal: 1, xp: 20, measure: count(won) },
  { id: "j_moyen2", name: "Montée en niveau", text: "Gagner 2 parties contre Moyen ou plus.", goal: 2, xp: 35, measure: count((g) => solo(g) && won(g) && atLeast(g, "medium")) },
  { id: "j_maisons15", name: "Bâtisseur", text: "Fermer 15 maisons au total.", goal: 15, xp: 25, measure: sum(mine) },
  { id: "j_maisons30", name: "Grand bâtisseur", text: "Fermer 30 maisons au total.", goal: 30, xp: 35, measure: sum(mine) },
  { id: "j_ligne1", name: "En ligne", text: "Gagner 1 partie en ligne.", goal: 1, xp: 40, measure: count((g) => online(g) && won(g)) },
  { id: "j_ligne2", name: "Rencontres", text: "Jouer 2 parties en ligne.", goal: 2, xp: 30, measure: count(online) },
  { id: "j_dur1", name: "Défi relevé", text: "Gagner 1 partie contre Difficile ou plus.", goal: 1, xp: 40, measure: count((g) => solo(g) && won(g) && atLeast(g, "hard")) },
  { id: "j_cinq", name: "Belle récolte", text: "Gagner en fermant au moins 5 maisons.", goal: 1, xp: 30, measure: count((g) => won(g) && mine(g) >= 5) },
  { id: "j_rapide", name: "Vite fait", text: "Gagner une partie en moins de 10 minutes.", goal: 1, xp: 30, measure: count((g) => won(g) && g.durationMs >= 1000 && g.durationMs <= 10 * 60 * 1000) },
  { id: "j_remontee", name: "Retour", text: "Gagner contre le robot après avoir été mené.", goal: 1, xp: 40, measure: count((g) => solo(g) && won(g) && g.behind === true) },
];

export const WEEKLY = [
  { id: "s_finir10", anti: true, name: "Jusqu’au bout de la semaine", text: "Finir 10 parties sans abandonner.", goal: 10, xp: 90, measure: count(finished) },
  { id: "s_ligne_finir5", anti: true, name: "Fair-play", text: "Finir 5 parties en ligne sans abandonner.", goal: 5, xp: 100, measure: count((g) => online(g) && finished(g)) },
  { id: "s_gagner10", name: "Dix victoires", text: "Gagner 10 parties.", goal: 10, xp: 100, measure: count(won) },
  { id: "s_jours4", name: "Fidèle", text: "Jouer 4 jours différents dans la semaine.", goal: 4, xp: 80, measure: (games) => new Set(games.map((g) => parisDay(g.at))).size },
  { id: "s_ligne5", name: "Joueur en ligne", text: "Gagner 5 parties en ligne.", goal: 5, xp: 120, measure: count((g) => online(g) && won(g)) },
  { id: "s_maisons100", name: "Cent maisons", text: "Fermer 100 maisons.", goal: 100, xp: 90, measure: sum(mine) },
  { id: "s_expert", name: "Battre l’Expert", text: "Gagner une partie contre l’Expert.", goal: 1, xp: 120, measure: count((g) => solo(g) && won(g) && g.difficulty === "expert") },
  { id: "s_serie3", name: "Trois d’affilée", text: "Gagner 3 parties d’affilée.", goal: 3, xp: 100, measure: bestWinRun },
  { id: "s_jouer20", name: "Marathon", text: "Jouer 20 parties.", goal: 20, xp: 80, measure: count(() => true) },
  { id: "s_blanche", name: "Sans rien laisser", text: "Gagner sans laisser une maison à l’autre.", goal: 1, xp: 100, measure: count((g) => won(g) && mine(g) > 0 && theirs(g) === 0) },
  { id: "s_mieux_classe", name: "Plus fort que soi", text: "Battre en ligne un joueur mieux classé que toi.", goal: 1, xp: 120, measure: count((g) => online(g) && won(g) && g.opponentHigher === true) },
  { id: "s_adversaires5", name: "Tour du monde", text: "Affronter 5 adversaires différents en ligne.", goal: 5, xp: 100, measure: (games) => new Set(games.filter((g) => online(g) && g.opponentId).map((g) => g.opponentId)).size },
  { id: "s_tournoi", name: "Esprit de tournoi", text: "Jouer un match de tournoi.", goal: 1, xp: 80, measure: count((g) => online(g) && g.tourney === true) },
  { id: "s_tresdur3", name: "Sans peur", text: "Gagner 3 parties contre Très difficile ou plus.", goal: 3, xp: 110, measure: count((g) => solo(g) && won(g) && atLeast(g, "veryhard")) },
];

export const DEFI_COUNT = 3;

/**
 * Succès en ligne : gagnés une seule fois, vérifiés par le serveur (classement et tournois).
 * state = { bestRank, tourneys, finals, champion8 }
 */
export const ONLINE_SUCCESS = [
  { id: "o_tournoi", name: "Premier tournoi", text: "Jouer un tournoi.", xp: 50, test: (s) => s.tourneys >= 1 },
  { id: "o_finale", name: "Finaliste", text: "Atteindre la finale d’un tournoi.", xp: 80, test: (s) => s.finals >= 1 },
  { id: "o_champion8", name: "Champion à 8", text: "Gagner un tournoi à 8 joueurs.", xp: 200, test: (s) => s.champion8 >= 1 },
  { id: "o_top10", name: "Top 10", text: "Entrer dans le Top 10 du classement général.", xp: 100, test: (s) => s.bestRank > 0 && s.bestRank <= 10 },
  { id: "o_top3", name: "Podium", text: "Entrer dans le Top 3 du classement général.", xp: 200, test: (s) => s.bestRank > 0 && s.bestRank <= 3 },
];

/* ---------- Heure de Paris ---------- */

const parisParts = (date) => {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Paris",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const get = (type) => Number(parts.find((part) => part.type === type)?.value) || 0;
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute"), second: get("second") };
};

/** Le jour à Paris, au format 2026-11-25. */
export function parisDay(at = Date.now()) {
  const p = parisParts(new Date(at));
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

function shiftDay(key, delta) {
  const [y, m, d] = key.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

/** Le lundi de la semaine (heure de Paris). */
export function parisWeek(at = Date.now()) {
  const day = parisDay(at);
  const [y, m, d] = day.split("-").map(Number);
  const weekday = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
  return shiftDay(day, -weekday);
}

/** Temps restant avant le prochain tirage, en millisecondes. */
export function msUntilRenew(kind, at = Date.now()) {
  const p = parisParts(new Date(at));
  const leftToday = 86400000 - ((p.hour * 3600 + p.minute * 60 + p.second) * 1000);
  if (kind !== "week") return leftToday;
  const [y, m, d] = parisDay(at).split("-").map(Number);
  const weekday = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
  return leftToday + (6 - weekday) * 86400000;
}

/* ---------- Tirage ---------- */

function seeded(text) {
  let h = 2166136261;
  for (const ch of text) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return () => {
    h = (h + 0x6d2b79f5) | 0;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(list, n, rand) {
  const pool = [...list];
  const out = [];
  while (out.length < n && pool.length) out.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
  return out;
}

/** Les défis tirés pour cette période : un « Jusqu'au bout » en premier, puis les autres. */
export function drawDefis(kind, period) {
  const list = kind === "week" ? WEEKLY : DAILY;
  const rand = seeded(`${kind}:${period}`);
  const anti = pick(list.filter((item) => item.anti), 1, rand);
  return [...anti, ...pick(list.filter((item) => !item.anti), DEFI_COUNT - anti.length, rand)];
}

/** Les défis de la période en cours avec leur progression. */
export function defisNow(kind, games, at = Date.now()) {
  const period = kind === "week" ? parisWeek(at) : parisDay(at);
  const mineNow = ownGames(games).filter((game) =>
    (kind === "week" ? parisWeek(game.at) : parisDay(game.at)) === period);
  return {
    period,
    renewMs: msUntilRenew(kind, at),
    items: drawDefis(kind, period).map((item) => {
      const value = Math.min(item.goal, Math.max(0, Number(item.measure(mineNow)) || 0));
      return { id: item.id, anti: item.anti === true, name: item.name, text: item.text, goal: item.goal, xp: item.xp, value, done: value >= item.goal };
    }),
  };
}

export function defiById(id) {
  return DAILY.find((item) => item.id === id) || WEEKLY.find((item) => item.id === id) || null;
}
