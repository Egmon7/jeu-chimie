import { parentPort } from "node:worker_threads";
import { analyzeLearnMatch } from "./learnAnalyze.js";
import { replayLearnMoves, sameSnapScores } from "./learn.js";

/** Travaux lourds du robot qui apprend, hors du fil qui fait tourner les matchs. */
parentPort.on("message", ({ id, op, match }) => {
  try {
    if (op === "analyze") {
      parentPort.postMessage({ id, ok: true, result: analyzeLearnMatch(match) });
      return;
    }
    if (op === "replay") {
      const game = replayLearnMoves(match.settings, match.starter, match.moves);
      const last = [...(match.moves || [])].reverse().find((move) => move?.after)?.after;
      parentPort.postMessage({
        id,
        ok: true,
        result: {
          ok: true,
          scores: game.scores.slice(),
          winner: game.winner,
          status: game.status,
          matchesFinal: sameSnapScores(last, game)
            && String(game.winner ?? "draw") === String(match.winner ?? "draw"),
        },
      });
      return;
    }
    parentPort.postMessage({ id, ok: false, error: "Travail inconnu." });
  } catch (error) {
    parentPort.postMessage({ id, ok: false, error: error.message });
  }
});
