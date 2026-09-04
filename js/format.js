// Mise en forme des nombres et des dates, a la francaise.

const MOIS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet",
  "août", "septembre", "octobre", "novembre", "décembre"];

const SEPARATEUR_MILLIERS = new Intl.NumberFormat("fr-FR");

export function nombre(valeur) {
  if (valeur === null || valeur === undefined || !isFinite(valeur)) return "—";
  return SEPARATEUR_MILLIERS.format(Math.round(valeur));
}

export function euros(valeur) {
  if (valeur === null || valeur === undefined || !isFinite(valeur)) return "—";
  return nombre(valeur) + " €";
}

export function eurosParM2(valeur) {
  if (valeur === null || valeur === undefined || !isFinite(valeur)) return "—";
  return nombre(valeur) + " €/m²";
}

export function surface(valeur) {
  if (valeur === null || valeur === undefined) return "—";
  return nombre(valeur) + " m²";
}

/** Transforme un numero de mois interne (0 = janvier 2020) en "mars 2024". */
export function moisEnTexte(t, anneeOrigine) {
  const annee = anneeOrigine + Math.floor(t / 12);
  return MOIS[((t % 12) + 12) % 12] + " " + annee;
}

/** Enleve les accents et la casse, pour que "nimes" trouve "Nîmes". */
export function sansAccents(texte) {
  return (texte || "").normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

/**
 * Rend un texte inoffensif dans du HTML.
 *
 * La liste et les infobulles sont construites en assemblant des chaines de
 * caracteres, puis posees dans la page via innerHTML. Tout texte qui n'a pas
 * ete fabrique par ce fichier doit passer par ici : sinon, taper
 * `<img src=x onerror=...>` dans la recherche executerait du code.
 *
 * L'esperluette est traitee EN PREMIER, sans quoi le "&" de "&lt;" produit a
 * l'etape suivante serait echappe a son tour et s'afficherait tel quel.
 */
export function echapper(texte) {
  return String(texte === null || texte === undefined ? "" : texte)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Petite barre d'etoiles de pertinence (0 a 5). */
export function etoiles(rapport) {
  const pleines = Math.max(1, Math.min(5, Math.round(rapport * 5)));
  return "★".repeat(pleines) + "☆".repeat(5 - pleines);
}
