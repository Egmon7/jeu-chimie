// Le robot réfléchit ici, à côté de l'affichage : l'écran du jeu reste fluide pendant son calcul.
import { chooseMove } from "./ai.js";

self.onmessage = (event) => {
  const { id, game, level } = event.data || {};
  let move = null;
  try {
    move = chooseMove(game, level);
  } catch {
    move = null;
  }
  self.postMessage({ id, move });
};
