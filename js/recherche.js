// Trouver une commune a partir de ce qu'une personne tape vraiment.
//
// Le probleme n'est pas de filtrer : c'est de CLASSER. Avant ce module, taper
// "ale" donnait soixante resultats dans l'ordre alphabetique par departement,
// et Ales arrivait en trente-troisieme position derriere L'Escale, Valensole et
// Saleon. Taper "Pont Saint Esprit" ne donnait rien du tout, parce que le vrai
// nom porte des traits d'union.
//
// Trois idees, dans cet ordre d'importance :
//   1. on compare des formes NORMALISEES, ou les separateurs ont disparu et ou
//      "St" vaut "Saint" ;
//   2. chaque resultat recoit un RANG, du plus evident au plus lointain ;
//   3. a rang egal, la commune la plus vendue passe devant -- c'est ce qui met
//      Ales (1249 ventes) devant Alenya (194) sur "ale".
//
// Aucun acces au DOM ici : ce fichier se teste en Node, comme estimation.js.

import { CONFIG } from "./config.js";
import { sansAccents } from "./format.js";

// Les abreviations que les gens ecrivent. Verifie sur les donnees reelles :
// AUCUN nom de commune des quatorze departements n'est ecrit "St" ou "Ste" --
// les 521 "Saint" et 39 "Sainte" sont en toutes lettres. Cette table ne sert
// donc qu'a la SAISIE ; on l'applique quand meme aux deux cotes, par symetrie.
const ABREGES = { st: "saint", ste: "sainte" };

// En dessous de trois caracteres, un debut de nom de departement ou de code
// INSEE ne veut plus rien dire : "py" designerait les Pyrenees-Orientales alors
// qu'on cherche la commune de Py, et "6" ramenait les 226 communes du 66 parce
// que leurs codes commencent par ce chiffre.
const MIN_PREFIXE_LARGE = 3;

// Plafond de resultats. Avec deux ou trois lettres tapees on passe presque
// toujours en dessous ; il protege les telephones du cas "a".
export const LIMITE_RESULTATS = 200;

/**
 * Les rangs, du meilleur au moins bon.
 *
 * L'ordre a ete regle sur des cas reels, pas au juge. Deux arbitrages meritent
 * d'etre expliques, parce qu'ils ne sont pas evidents :
 *
 * - DEBUT_NET avant DEPARTEMENT_NOMME : taper "sainte" doit donner les vraies
 *   Sainte-* avant les communes du departement qu'on n'a pas nomme.
 * - DEPARTEMENT_NOMME avant DEBUT : taper "var" doit donner Toulon avant
 *   Varilhes, qui est en Ariege. Sans cet ordre, nommer un departement etait
 *   toujours battu par n'importe quel debut de nom, et la fonction ne servait
 *   a rien.
 */
export const RANG = {
  EXACT: 1,              // "Ales" -> Ales · "30189" -> Nimes
  DEBUT_NET: 2,          // "sainte" -> Sainte-Maxime (le mot s'arrete la)
  DEPARTEMENT_NOMME: 3,  // "30", "Gard", "Haute-Garonne" -> tout le departement
  DEBUT: 4,              // "ale" -> Ales (on coupe au milieu du mot)
  MOTS_EN_DEBUT: 5,      // "St Esprit" -> Pont-Saint-Esprit
  MOTS_PRESENTS: 6,      // chaque mot tape est quelque part dans le nom
  APPROCHANT: 7,         // "garonne" -> la Haute-Garonne · "301" -> codes 301xx
};

/**
 * Reduit un texte a sa forme comparable.
 *
 * Renvoie trois choses, parce que les trois servent :
 *   - "mots"       pour retrouver "esprit" au milieu d'un nom compose ;
 *   - "colle"      pour que "Pont Saint Esprit" rejoigne "Pont-Saint-Esprit" ;
 *   - "frontieres" les positions ou un mot se termine DANS la forme collee.
 *
 * Les frontieres sont ce qui empeche "sainte" de reconnaitre Saint-Estienne :
 * les deux formes collees commencent bien par "sainte", mais dans l'une le mot
 * s'arrete la, dans l'autre on coupe "esteve" en deux.
 *
 * L'ordre des operations n'est pas libre : il faut expanser AVANT de coller,
 * sans quoi "st" n'est plus un mot isolable. Et l'expansion porte sur le mot
 * ENTIER, jamais sur un debut de mot, pour ne pas transformer un nom qui
 * commencerait par ces deux lettres.
 */
export function normaliser(texte) {
  const mots = sansAccents(texte)
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((mot) => ABREGES[mot] || mot);
  const frontieres = new Set();
  let position = 0;
  for (const mot of mots) {
    position += mot.length;
    frontieres.add(position);
  }
  return { mots, colle: mots.join(""), frontieres };
}

/**
 * Prepare une fois pour toutes les formes comparables des communes.
 *
 * Environ 12 ms pour 3945 communes, au chargement. Ce n'est pas une
 * optimisation -- le filtre naif ne coutait que 1,6 ms par frappe : c'est ce
 * qui rend les mots et les frontieres disponibles sans les recalculer.
 */
export function indexerCommunes(communes) {
  return communes.map((commune) => {
    const { mots, colle, frontieres } = normaliser(commune.nom);
    return { commune, mots, colle, frontieres };
  });
}

// Forme comparable du nom de chaque departement, calculee une seule fois.
const DEPARTEMENTS_NORMALISES = CONFIG.DEPARTEMENTS.map((departement) => ({
  code: departement.code,
  ...normaliser(departement.nom),
}));

/** Chaque mot cherche commence-t-il un mot de cette liste ? */
function motsEnDebutDe(cherches, mots) {
  return cherches.every((cherche) => mots.some((mot) => mot.startsWith(cherche)));
}

/**
 * Les departements designes par une saisie, separes en deux niveaux.
 *
 * "nommes"     : la saisie EST le departement -- son numero a deux chiffres,
 *                ou son nom complet. C'est une intention claire.
 * "approchants": la saisie n'est qu'un bout de son nom ("garonne" pour la
 *                Haute-Garonne). C'est une piste, pas une intention.
 *
 * Un numero est reconnu sur EXACTEMENT deux chiffres. On ne complete pas "6"
 * en "06" : ce serait deviner. Les departements s'ecrivent partout sur deux
 * chiffres, y compris dans les codes INSEE.
 */
function departementsDesignes(requete) {
  const nommes = new Set();
  const approchants = new Set();
  const assezLong = requete.colle.length >= MIN_PREFIXE_LARGE;
  for (const departement of DEPARTEMENTS_NORMALISES) {
    if (requete.colle === departement.code || requete.colle === departement.colle) {
      nommes.add(departement.code);
    } else if (assezLong && motsEnDebutDe(requete.mots, departement.mots)) {
      approchants.add(departement.code);
    }
  }
  return { nommes, approchants };
}

/** Le rang d'une commune pour cette saisie, ou null si elle ne correspond pas. */
function rangDe(entree, requete, departements) {
  const { colle, mots, commune } = entree;
  if (colle === requete.colle || commune.code === requete.colle) return RANG.EXACT;

  const commencePar = colle.startsWith(requete.colle);
  if (commencePar && entree.frontieres.has(requete.colle.length)) return RANG.DEBUT_NET;
  if (departements.nommes.has(commune.dep)) return RANG.DEPARTEMENT_NOMME;
  if (commencePar) return RANG.DEBUT;
  if (motsEnDebutDe(requete.mots, mots)) return RANG.MOTS_EN_DEBUT;
  if (requete.mots.every((mot) => colle.includes(mot))) return RANG.MOTS_PRESENTS;
  if (departements.approchants.has(commune.dep)) return RANG.APPROCHANT;
  // Un debut de code INSEE, mais pas sur un ou deux caracteres : "3" visait
  // ainsi les 1285 communes du 30 et du 31 d'un coup.
  if (requete.colle.length >= MIN_PREFIXE_LARGE && commune.code.startsWith(requete.colle)) {
    return RANG.APPROCHANT;
  }
  return null;
}

/**
 * Cherche dans un index prepare par indexerCommunes.
 *
 * Renvoie des objets {commune, rang}, les meilleurs d'abord, au plus "limite".
 * Une saisie vide -- ou faite de separateurs seuls, "-" ou "'" -- ne renvoie
 * rien : sans ce garde-fou, "commence par la chaine vide" serait vrai pour
 * toutes les communes et la liste entiere s'afficherait comme un resultat.
 */
export function chercher(index, texte, limite = LIMITE_RESULTATS) {
  const requete = normaliser(texte);
  if (!requete.colle) return [];

  const departements = departementsDesignes(requete);
  const trouves = [];
  for (const entree of index) {
    const rang = rangDe(entree, requete, departements);
    if (rang !== null) trouves.push({ commune: entree.commune, rang });
  }

  // A rang egal : les communes sans aucune vente en dernier -- elles afficheront
  // « donnees insuffisantes » et ne savent rien estimer, elles n'ont rien a
  // faire en tete. Puis la plus vendue. Puis l'ordre alphabetique, qui n'est
  // pas cosmetique : sans lui, deux communes de meme rang et de meme nombre de
  // ventes pourraient changer de place d'un appel a l'autre.
  trouves.sort((a, b) => a.rang - b.rang
    || (a.commune.n ? 0 : 1) - (b.commune.n ? 0 : 1)
    || (b.commune.n || 0) - (a.commune.n || 0)
    || a.commune.nom.localeCompare(b.commune.nom, "fr"));

  return trouves.slice(0, limite);
}
