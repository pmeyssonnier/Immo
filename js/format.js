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

/**
 * Lien Google Maps -- le PLAN -- a la position exacte d'une vente.
 *
 * Complement de lienStreetView ci-dessous, et non doublon : le plan existe
 * partout et montre les alentours, les acces et la vue satellite ; Street View
 * montre la facade, quand une prise de vue existe. L'un repond a « ou est-ce ? »,
 * l'autre a « a quoi ca ressemble ? ».
 *
 * Meme precaution que pour Street View sur les coordonnees absentes : voir le
 * commentaire ci-dessous, notamment le piege de isFinite(null).
 */

/**
 * Lien Google Street View a la position exacte d'une vente.
 *
 * DVF geolocalise chaque mutation a la parcelle, ce qui suffit pour amener
 * Street View devant la bonne facade. On passe donc par les coordonnees et non
 * par l'adresse : un libelle DVF comme « 12 RUE ... » se retrouve mal, alors
 * qu'une latitude et une longitude ne s'interpretent pas.
 *
 * Format officiel de l'API des URL Google Maps (map_action=pano).
 *
 * ATTENTION a ce que ce lien NE garantit PAS : Street View ne couvre pas toutes
 * les voies, en particulier les chemins ruraux et les lotissements prives, tres
 * presents sur ce territoire. Savoir a l'avance s'il existe une prise de vue
 * demanderait l'API payante de Google. L'interface annonce donc la limite plutot
 * que de promettre une photo.
 *
 * Renvoie null si la position manque, pour que l'appelant n'affiche pas de lien
 * mort. Number.isFinite et non isFinite : le second convertit null en 0 et
 * accepterait une vente sans coordonnees.
 */
export function lienGoogleMaps(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return `https://www.google.com/maps/search/?api=1&query=${lat.toFixed(6)},${lon.toFixed(6)}`;
}

export function lienStreetView(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return "https://www.google.com/maps/@?api=1&map_action=pano"
    + `&viewpoint=${lat.toFixed(6)},${lon.toFixed(6)}`;
}
