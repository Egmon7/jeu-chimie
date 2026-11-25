import assert from "assert/strict";
import { DAILY, WEEKLY, DEFI_COUNT, ONLINE_SUCCESS, defisNow, drawDefis, msUntilRenew, parisDay, parisWeek } from "../public/js/defis.js";

// 1) Heure de Paris : jour, lundi de la semaine, passage de minuit.
{
  // 24/11/2026 à 23 h 30 UTC = 25/11 à 0 h 30 à Paris (heure d'hiver).
  const at = Date.UTC(2026, 10, 24, 23, 30);
  assert.equal(parisDay(at), "2026-11-25");
  assert.equal(parisWeek(at), "2026-11-23", "le mercredi 25 est dans la semaine du lundi 23");
  assert.equal(parisWeek(Date.UTC(2026, 10, 29, 12)), "2026-11-23", "le dimanche reste dans la même semaine");
  assert.equal(parisWeek(Date.UTC(2026, 10, 29, 23, 30)), "2026-11-30", "lundi 0 h 30 à Paris : nouvelle semaine");
  assert.equal(msUntilRenew("day", at), 23.5 * 3600000);
  assert.equal(msUntilRenew("week", at), 23.5 * 3600000 + 4 * 86400000);
}

// 2) Tirage : le même pour tout le monde, 3 défis différents, toujours un « Jusqu'au bout » en premier.
{
  const ids = new Set();
  for (let d = 0; d < 60; d += 1) {
    const day = new Date(Date.UTC(2026, 0, 1 + d)).toISOString().slice(0, 10);
    const draw = drawDefis("day", day);
    assert.equal(draw.length, DEFI_COUNT);
    assert.equal(new Set(draw.map((item) => item.id)).size, DEFI_COUNT, "pas de doublon");
    assert.equal(draw.filter((item) => item.anti).length, 1, "un seul « Jusqu’au bout »");
    assert.equal(draw[0].anti, true);
    assert.deepEqual(draw.map((item) => item.id), drawDefis("day", day).map((item) => item.id), "tirage stable");
    draw.forEach((item) => ids.add(item.id));
    const week = drawDefis("week", day);
    assert.equal(week.length, DEFI_COUNT);
    assert.ok(week.every((item) => WEEKLY.includes(item)));
  }
  assert.ok(ids.size > DAILY.length / 2, "les défis tournent");
  const all = [...DAILY, ...WEEKLY].map((item) => item.id);
  assert.equal(new Set(all).size, all.length, "identifiants uniques");
  assert.ok(DAILY.every((item) => item.id.startsWith("j_")) && WEEKLY.every((item) => item.id.startsWith("s_")));
}

// 3) Progression : seules les parties de la période comptent, l'abandon ne compte pas comme « fini ».
{
  const now = Date.UTC(2026, 10, 25, 12);
  const g = (o) => ({ at: now, mode: "solo", userSeat: 0, scores: [6, 2], winner: "0", reason: "score", difficulty: "hard", durationMs: 300000, ...o });
  const games = [
    g({}),
    g({ reason: "abandon", winner: "1", scores: [1, 3] }),
    g({ mode: "online", userSeat: 1, scores: [2, 7], winner: "1" }),
    g({ at: now - 86400000 }), // hier : compte pour la semaine, pas pour le jour
    g({ mode: "local", userSeat: null }), // même écran : ne compte pas
  ];
  const day = defisNow("day", games, now);
  const week = defisNow("week", games, now);
  assert.equal(day.period, "2026-11-25");
  assert.equal(week.period, "2026-11-23");
  const measure = (list, id, set) => list.find((item) => item.id === id).measure(set);
  const today = games.slice(0, 3);
  assert.equal(measure(DAILY, "j_finir2", today), 2, "l’abandon ne compte pas");
  assert.equal(measure(DAILY, "j_jouer3", today), 3);
  assert.equal(measure(DAILY, "j_gagner1", today), 2, "victoire en ligne à la place 1 comptée");
  assert.equal(measure(DAILY, "j_maisons15", today), 14);
  assert.equal(measure(DAILY, "j_ligne1", today), 1);
  assert.equal(measure(WEEKLY, "s_serie3", [g({ at: 1 }), g({ at: 2 }), g({ at: 3, winner: "1" }), g({ at: 4 })]), 2);
  for (const item of [...day.items, ...week.items]) {
    assert.ok(item.value >= 0 && item.value <= item.goal, "valeur bornée à l’objectif");
    assert.equal(item.done, item.value >= item.goal);
  }
}

// 4) Défis en ligne : adversaire mieux classé, adversaires différents, match de tournoi.
{
  const g = (o) => ({ at: 1, mode: "online", userSeat: 0, scores: [5, 2], winner: "0", reason: "score", opponentId: "a", ...o });
  const measure = (id, set) => WEEKLY.find((item) => item.id === id).measure(set);
  const set = [
    g({ opponentHigher: true }),
    g({ opponentHigher: true, winner: "1", scores: [1, 5] }), // perdu : ne compte pas
    g({ opponentId: "b" }), g({ opponentId: "b" }), g({ opponentId: "c", tourney: true }),
    g({ mode: "solo", opponentId: "z", opponentHigher: true }), // contre le robot : ne compte pas
  ];
  assert.equal(measure("s_mieux_classe", set), 1);
  assert.equal(measure("s_adversaires5", set), 3);
  assert.equal(measure("s_tournoi", set), 1);
}

// 5) Succès en ligne.
{
  const done = (state) => ONLINE_SUCCESS.filter((item) => item.test(state)).map((item) => item.id);
  assert.deepEqual(done({ bestRank: 0, tourneys: 0, finals: 0, champion8: 0 }), []);
  assert.deepEqual(done({ bestRank: 7, tourneys: 1, finals: 0, champion8: 0 }), ["o_tournoi", "o_top10"]);
  assert.deepEqual(done({ bestRank: 2, tourneys: 3, finals: 1, champion8: 1 }), ["o_tournoi", "o_finale", "o_champion8", "o_top10", "o_top3"]);
}

console.log("defis ok");
