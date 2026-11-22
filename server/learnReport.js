/** Rapport écrit uniquement à partir des chiffres réellement en base. */

const KIND_LABEL = {
  chain_short: "chaînes courtes",
  chain_long: "chaînes longues",
  endgame: "fins de partie",
  sacrifice: "sacrifices utiles",
  double_cross: "double-cross",
};

const STATUS_LABEL = {
  "pas commencé": "Pas commencé",
  collecte: "Collecte",
  analyse: "Analyse",
  entrainement: "Entraînement",
  validation: "Validation",
  termine: "Terminé",
  echec: "Échec",
  indisponible: "Indisponible",
};

export function statusLabel(status) {
  return STATUS_LABEL[status] || status || "Pas commencé";
}

export function buildLearnReport(overview) {
  const matches = Number(overview?.matches) || 0;
  const moves = Number(overview?.moves) || 0;
  const sits = overview?.situations || {};
  const sitTotal = Number(sits.total) || 0;
  const byKind = sits.byKind || {};
  const byOutcome = sits.byOutcome || {};
  const watch = overview?.watch || [];
  const model = overview?.model || {};
  const lines = [];

  if (!matches) {
    return "Aucune partie gardée pour l’instant. Le rapport apparaîtra dès qu’une partie suivie sera enregistrée.";
  }

  lines.push(`Parties gardées : ${matches}.`);
  lines.push(`Coups enregistrés : ${moves}.`);
  lines.push(`Situations retenues : ${sitTotal}.`);

  if (watch.length) {
    lines.push(`Comptes trouvés en base : ${watch.map((row) => row.name).join(", ")}.`);
  } else {
    lines.push("Aucun des comptes suivis n’a encore été trouvé en base.");
  }

  if (sitTotal) {
    const parts = Object.entries(KIND_LABEL)
      .map(([key, label]) => {
        const n = Number(byKind[key]) || 0;
        return n ? `${n} ${label}` : "";
      })
      .filter(Boolean);
    if (parts.length) lines.push(`Détail : ${parts.join(", ")}.`);
    lines.push(
      `Parmi ces situations : ${Number(byOutcome.win) || 0} liées à une victoire, ${Number(byOutcome.loss) || 0} à une défaite, ${Number(byOutcome.draw) || 0} à une égalité.`,
    );
  } else {
    lines.push("Les coups sont là, mais aucune situation n’a encore été lue.");
  }

  const active = model.activeVersion || "v1";
  const candidate = model.candidateVersion || null;
  lines.push(`Version en jeu : ${active}.`);
  if (candidate) lines.push(`Candidat en attente : ${candidate}.`);
  else lines.push("Pas encore de robot candidat (phase 3 non terminée).");

  if (model.veryhardUsesCandidate || model.expertUsesCandidate) {
    const on = [
      model.veryhardUsesCandidate ? "Très difficile" : "",
      model.expertUsesCandidate ? "Expert" : "",
    ].filter(Boolean);
    lines.push(`Candidat activé pour : ${on.join(" et ")}.`);
  } else {
    lines.push("Facile et Moyen restent inchangés. Aucun candidat n’est activé sur Très difficile / Expert.");
  }

  return lines.join(" ");
}
