// Reglages generaux de l'application. Tout ce qui peut se regler est ici.

export const CONFIG = {
  // Centre de la carte au demarrage : entre le Gard et l'Ardeche
  CENTRE: [44.25, 4.35],
  ZOOM_INITIAL: 8,
  ZOOM_MIN: 7,
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

  DEPARTEMENTS: { 30: "Gard", "07": "Ardèche" },
};

/** Couleur d'une commune selon son prix au m2 (gris si donnees insuffisantes). */
export function couleurPrix(prixM2, seuils) {
  if (prixM2 === null || prixM2 === undefined) return CONFIG.COULEUR_SANS_DONNEES;
  let index = 0;
  while (index < seuils.length && prixM2 >= seuils[index]) index += 1;
  return CONFIG.COULEURS[Math.min(index, CONFIG.COULEURS.length - 1)];
}
