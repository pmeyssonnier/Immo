// ---------------------------------------------------------------------------
// SUIVI DES DEMANDES
// ---------------------------------------------------------------------------
// Une estimation demande plusieurs telechargements, donc plusieurs attentes.
// Pendant ces attentes, l'utilisateur peut tres bien cliquer une autre commune
// ou relancer un calcul. Sans precaution, le calcul le plus LENT ecrit son
// resultat en dernier -- et le montant de Nimes s'affiche sous le titre d'Uzes.
//
// Le principe tient en une phrase : chaque demande recoit un numero, et apres
// chaque attente on verifie qu'aucune demande plus recente n'est partie. Si
// c'est le cas, la demande en cours abandonne sans rien afficher.
//
// Pourquoi pas AbortController : les telechargements passent par un cache
// partage (voir donnees.js). Annuler pour un appelant casserait la promesse de
// tous les autres qui attendent le meme fichier.
// ---------------------------------------------------------------------------

export function creerSuiviDeDemandes() {
  let derniere = 0;
  return {
    /** Ouvre une nouvelle demande et renvoie son numero. */
    nouvelle() {
      derniere += 1;
      return derniere;
    },
    /** Cette demande est-elle toujours la plus recente ? */
    estLaDerniere(jeton) {
      return jeton === derniere;
    },
  };
}
