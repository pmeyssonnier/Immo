// Chercher une adresse, et non plus seulement une commune.
//
// Deux chemins, parce que les donnees ne sont pas au meme endroit :
//
//   1. DANS UNE COMMUNE OUVERTE -- ses ventes sont deja telechargees. On y
//      cherche l'adresse exacte et on renvoie les VENTES elles-memes, avec leur
//      prix, leur surface et leur date. Instantane, aucun octet de plus.
//
//   2. SANS COMMUNE CHOISIE -- il faut d'abord savoir ou chercher. C'est le
//      role de data/voies.json, un annuaire « libelle de voie -> communes »
//      telecharge uniquement le jour ou l'on tape une adresse. Il pese 0,8 Mo
//      compresse ; y mettre les ventes elles-memes en aurait fait 4,4.
//
// Les adresses DVF sont abregees : "CHE DE LA MARJOLAINE", "RTE DE COURBESSAC",
// "ACH ANCIEN CHEMIN DE SALERNES". Taper "chemin de la marjolaine" doit les
// trouver. La table ci-dessous est relevee sur les donnees reelles, pas devinee.

import { normaliser } from "./recherche.js";

/**
 * Abreviations de voie, telles qu'elles apparaissent vraiment dans DVF.
 *
 * Les huit premieres couvraient 87 % des adresses, mesure faite sur les
 * 14 departements d'alors -- avant l'ajout des 7 d'Occitanie.
 * Les suivantes ont ete verifiees une par une sur des exemples : ACH precede
 * toujours "ANCIEN CHEMIN", RPT "ROND-POINT", VC "VOIE COMMUNALE", CAE une
 * carraire (chemin de transhumance provencal), CAMI le mot occitan pour chemin.
 *
 * L'expansion s'applique aux DEUX cotes -- l'adresse indexee comme la saisie --
 * si bien que "chemin", "che" et "chem" se rejoignent tous sur "chemin".
 *
 * Une abreviation n'entre ici que si elle apporte quelque chose. Beaucoup
 * s'expliquent toutes seules : releve sur les 365 316 adresses des 14
 * departements d'alors, GR est TOUJOURS suivi de "GRAND RUE" ou "GRANDE RUE" (1 293
 * cas), et VTE de "VIEILLE ROUTE" ou "VIEILLE RTE" (104 cas). Ces voies se
 * trouvent donc deja sans rien ajouter, et les inscrire ici ne ferait que
 * dupliquer le texte indexe -- "GR GRAND RUE" deviendrait "grandruegrandrue",
 * ce qui degrade le classement sans rien gagner. Elles sont volontairement
 * absentes. RLE, CTRE et ART, eux, ne s'expliquent jamais ("RLE DE LA ...",
 * "CTRE LES HAUTS ...", "ART DE MORMOIRON") : sans eux, taper "ruelle",
 * "centre" ou "ancienne route" ne trouvait rien.
 */
const ABREGES_VOIE = {
  rue: "rue",
  rle: "ruelle", ruelle: "ruelle",
  ctre: "centre", centre: "centre",
  che: "chemin", chem: "chemin", chemin: "chemin", cami: "chemin",
  av: "avenue", ave: "avenue", avenue: "avenue",
  imp: "impasse", impasse: "impasse",
  rte: "route", route: "route",
  all: "allee", allee: "allee",
  lot: "lotissement", lotissement: "lotissement",
  bd: "boulevard", bld: "boulevard", boulevard: "boulevard",
  res: "residence", residence: "residence",
  pl: "place", place: "place",
  tra: "traverse", traverse: "traverse",
  mte: "montee", montee: "montee",
  ham: "hameau", hameau: "hameau",
  crs: "cours", cours: "cours",
  pas: "passage", passage: "passage",
  qua: "quartier", quartier: "quartier",
  sq: "square", square: "square",
  tsse: "terrasse", terrasse: "terrasse",
  dom: "domaine", domaine: "domaine",
  vla: "villa", villa: "villa",
  chs: "chaussee", chaussee: "chaussee",
  cor: "corniche", corniche: "corniche",
  car: "carrefour", carrefour: "carrefour",
  cae: "carraire", carraire: "carraire",
  sen: "sente", sente: "sente",
  pte: "porte", porte: "porte",
  ach: "ancien chemin",
  art: "ancienne route",
  rpt: "rond point",
  vc: "voie communale",
  za: "zone artisanale",
};

// Les mots qui font dire « ceci est une adresse, pas un nom de ville ».
// C'est ce qui declenche le telechargement de l'annuaire : on ne le charge
// jamais pour rien.
const MOTS_DE_VOIE = new Set(Object.values(ABREGES_VOIE));

export const LIMITE_ADRESSES = 200;

/**
 * Forme comparable d'une adresse ou d'une saisie.
 *
 * Renvoie aussi le numero de voirie s'il y en a un : il ne sert pas a chercher
 * la voie -- l'annuaire n'en contient pas -- mais a designer la bonne vente une
 * fois la commune chargee.
 */
export function normaliserAdresse(texte) {
  const brut = normaliser(texte);
  const mots = [];
  let numero = null;
  for (const mot of brut.mots) {
    if (numero === null && /^\d+$/.test(mot) && !mots.length) {
      numero = mot;                       // "12" de "12 rue Ampere"
      continue;
    }
    const developpe = ABREGES_VOIE[mot];
    if (developpe) mots.push(...developpe.split(" "));
    else mots.push(mot);
  }
  return { mots, colle: mots.join(""), numero };
}

/** La saisie ressemble-t-elle a une adresse plutot qu'a un nom de ville ? */
export function ressembleAUneAdresse(texte) {
  const { mots, numero } = normaliserAdresse(texte);
  if (numero !== null && mots.length) return true;
  return mots.some((mot) => MOTS_DE_VOIE.has(mot));
}

// --------------------------------------------------------------------------
// 1. Dans une commune deja ouverte : les ventes elles-memes
// --------------------------------------------------------------------------

/**
 * Cherche parmi les ventes DEJA chargees d'une commune.
 *
 * Renvoie des objets {vente, indice}, les mieux places d'abord : le numero de
 * voirie exact avant le reste, puis les ventes les plus recentes.
 */
export function chercherVentes(ventes, texte, limite = LIMITE_ADRESSES, nomCommune = null) {
  const requete = normaliserAdresse(texte);
  if (!requete.colle) return [];

  // Le nom de la ville peut avoir ete tape a la suite -- « avenue jean jaures
  // nimes » --, et il ne figure evidemment pas dans les adresses de cette
  // ville. On le retire, sinon rien ne correspondrait jamais apres avoir
  // clique un resultat de l'annuaire.
  let mots = requete.mots;
  if (nomCommune) {
    const nom = normaliser(nomCommune).mots;
    for (let debut = 0; debut + nom.length <= mots.length; debut += 1) {
      if (nom.every((mot, i) => mots[debut + i] === mot)) {
        const restant = mots.slice(0, debut).concat(mots.slice(debut + nom.length));
        if (restant.length) mots = restant;
        break;
      }
    }
  }

  const trouves = [];
  for (let indice = 0; indice < ventes.length; indice += 1) {
    const vente = ventes[indice];
    const adresse = normaliserAdresse(vente.adresse || "");
    if (!mots.every((mot) => adresse.colle.includes(mot))) continue;
    // Le numero demande doit correspondre s'il a ete precise ; sinon toute la
    // voie remonte, ce qui est exactement ce qu'on veut pour comparer.
    const memeNumero = requete.numero !== null && adresse.numero === requete.numero;
    if (requete.numero !== null && adresse.numero !== null && !memeNumero) {
      trouves.push({ vente, indice, exact: false });
    } else {
      trouves.push({ vente, indice, exact: memeNumero });
    }
  }

  trouves.sort((a, b) => (b.exact ? 1 : 0) - (a.exact ? 1 : 0)
    || (b.vente.t || 0) - (a.vente.t || 0));
  return trouves.slice(0, limite);
}

// --------------------------------------------------------------------------
// 2. Sans commune choisie : l'annuaire des voies
// --------------------------------------------------------------------------

/** Prepare l'annuaire telecharge (format colonnaire {champs, valeurs}). */
export function indexerVoies(table) {
  const iVoie = table.champs.indexOf("voie");
  const iCommunes = table.champs.indexOf("communes");
  return table.valeurs.map((ligne) => {
    const voie = ligne[iVoie];
    const { mots, colle } = normaliserAdresse(voie);
    return { voie, communes: ligne[iCommunes], mots, colle };
  });
}

/**
 * Cherche une voie dans l'annuaire.
 *
 * Renvoie des objets {voie, commune}, une ligne par couple : « RUE AMPERE » a
 * Nimes et « RUE AMPERE » a Toulon sont deux resultats distincts, sans quoi on
 * ne saurait pas ou aller.
 *
 * "communesParCode" sert a deux choses : ecarter les communes inconnues, et
 * classer -- a defaut de mieux, la commune la plus vendue d'abord, comme pour
 * la recherche de communes.
 */
export function chercherVoies(index, texte, communesParCode, limite = LIMITE_ADRESSES) {
  const requete = normaliserAdresse(texte);
  if (!requete.mots.length) return [];

  // Le nom de commune peut etre tape a la suite : "rue ampere nimes". On
  // cherche donc, parmi les suites de mots consecutifs de la requete, celles
  // qui sont EXACTEMENT un nom de commune.
  //
  // L'egalite n'est pas un exces de prudence. Chercher le nom « quelque part
  // dans la saisie » ramenait la commune de Ur, dans les Pyrenees-Orientales,
  // pour toute adresse contenant « jaures » -- « ja-UR-es ». Toute la recherche
  // basculait sur cette seule commune.
  const parNom = new Map();
  for (const commune of communesParCode.values()) {
    const nom = normaliser(commune.nom).colle;
    if (!nom) continue;
    if (!parNom.has(nom)) parNom.set(nom, []);
    parNom.get(nom).push(commune.code);
  }
  // On retient la PLUS LONGUE suite de mots qui soit un nom de commune, et on
  // la retire de ce qui sert a chercher la voie. Sans ce retrait, « avenue jean
  // jaures nimes » acceptait « AV JEAN LASSERRE » : il suffisait que deux mots
  // sur quatre correspondent.
  let nomsVises = new Set();
  let motsDeLaVoie = requete.mots;
  for (let debutMot = 0; debutMot < requete.mots.length; debutMot += 1) {
    for (let finMot = requete.mots.length; finMot > debutMot; finMot -= 1) {
      const codes = parNom.get(requete.mots.slice(debutMot, finMot).join(""));
      if (!codes) continue;
      const restant = requete.mots.slice(0, debutMot).concat(requete.mots.slice(finMot));
      // Une commune seule n'est pas une adresse : on ne retient le nom de ville
      // que s'il reste quelque chose a chercher.
      if (restant.length && restant.length < motsDeLaVoie.length) {
        nomsVises = new Set(codes);
        motsDeLaVoie = restant;
      }
    }
  }

  const colleVoie = motsDeLaVoie.join("");
  const trouves = [];
  for (const entree of index) {
    // TOUS les mots restants doivent etre presents dans le libelle de voie.
    if (!motsDeLaVoie.every((mot) => entree.colle.includes(mot))) continue;

    const exacte = entree.colle === colleVoie;
    const debut = entree.colle.startsWith(colleVoie);
    for (const code of entree.communes) {
      const commune = communesParCode.get(code);
      if (!commune) continue;
      if (nomsVises.size && !nomsVises.has(code)) continue;
      trouves.push({ voie: entree.voie, commune, rang: exacte ? 1 : debut ? 2 : 3 });
    }
  }

  trouves.sort((a, b) => a.rang - b.rang
    || (b.commune.n || 0) - (a.commune.n || 0)
    || a.voie.localeCompare(b.voie, "fr")
    || a.commune.nom.localeCompare(b.commune.nom, "fr"));
  return trouves.slice(0, limite);
}
