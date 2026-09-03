// Reglages generaux de l'application. Tout ce qui peut se regler est ici.

export const CONFIG = {
  // Cadrage de secours si les coordonnees des communes sont indisponibles.
  // En temps normal la carte se cadre toute seule sur les departements charges
  // (voir cadrerSurLesDonnees dans carte.js) : ajouter un departement ne demande
  // donc aucun reglage ici.
  CENTRE: [43.9, 4.7],
  ZOOM_INITIAL: 7,
  ZOOM_MIN: 6,
  ZOOM_MAX: 18,

  // Au-dela de ce zoom on montre les ventes une par une plutot que les communes
  ZOOM_BASCULE_VENTES: 12,
  // Nombre maximum de communes chargees d'un coup quand on navigue a la carte
  MAX_COMMUNES_SIMULTANEES: 12,

  // Fond de plan. C'est un CONFORT : si les tuiles ne se chargent pas, les
  // contours des communes restent parfaitement lisibles.
  TUILES: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
  ATTRIBUTION: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',

  // Palette du plus clair (le moins cher) au plus fonce (le plus cher).
  // Sequence "YlOrRd" : lisible aussi par les personnes daltoniennes.
  COULEURS: ["#ffffb2", "#fed976", "#feb24c", "#fd8d3c", "#fc4e2a", "#e31a1c", "#b10026"],
  COULEUR_SANS_DONNEES: "#d9d9d9",

  // Departements couverts, dans l'ordre d'affichage de la liste.
  //
  // C'est une LISTE et non un objet, et ce n'est pas un detail : en JavaScript,
  // les cles d'objet qui ressemblent a des nombres entiers ("11", "26"...) sont
  // toujours parcourues en premier, dans l'ordre croissant, avant les autres.
  // Avec un objet, "06" et "07" se retrouvaient donc rejetes en fin de liste.
  // Une liste, elle, garde l'ordre qu'on lui donne.
  //
  // Doit rester en accord avec DEPARTEMENTS dans scripts/preparer_donnees.py.
  DEPARTEMENTS: [
    { code: "04", nom: "Alpes-de-Haute-Provence" },
    { code: "05", nom: "Hautes-Alpes" },
    { code: "06", nom: "Alpes-Maritimes" },
    { code: "07", nom: "Ardèche" },
    { code: "09", nom: "Ariège" },
    { code: "11", nom: "Aude" },
    { code: "13", nom: "Bouches-du-Rhône" },
    { code: "26", nom: "Drôme" },
    { code: "30", nom: "Gard" },
    { code: "31", nom: "Haute-Garonne" },
    { code: "34", nom: "Hérault" },
    { code: "66", nom: "Pyrénées-Orientales" },
    { code: "83", nom: "Var" },
    { code: "84", nom: "Vaucluse" },
  ],
};

/** Nom d'un departement a partir de son code, ou le code si on ne le connait pas. */
export function nomDepartement(code) {
  const trouve = CONFIG.DEPARTEMENTS.find((d) => d.code === code);
  return trouve ? trouve.nom : code;
}

/** Couleur d'une commune selon son prix au m2 (gris si donnees insuffisantes). */
export function couleurPrix(prixM2, seuils) {
  if (prixM2 === null || prixM2 === undefined) return CONFIG.COULEUR_SANS_DONNEES;
  let index = 0;
  while (index < seuils.length && prixM2 >= seuils[index]) index += 1;
  return CONFIG.COULEURS[Math.min(index, CONFIG.COULEURS.length - 1)];
}
