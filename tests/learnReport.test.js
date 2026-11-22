import assert from "assert/strict";
import { buildLearnReport, statusLabel } from "../server/learnReport.js";

assert.equal(statusLabel("analyse"), "Analyse");
assert.match(buildLearnReport({ matches: 0 }), /Aucune partie/);
const text = buildLearnReport({
  matches: 2,
  moves: 40,
  watch: [{ name: "Ntotimbe" }],
  situations: {
    total: 5,
    byKind: { chain_short: 2, double_cross: 1 },
    byOutcome: { win: 3, loss: 2, draw: 0 },
  },
  model: { activeVersion: "v1", candidateVersion: null },
});
assert.match(text, /Parties gardées : 2/);
assert.match(text, /Situations retenues : 5/);
assert.match(text, /Ntotimbe/);
assert.match(text, /Pas encore de robot candidat/);
console.log("learnReport ok");
