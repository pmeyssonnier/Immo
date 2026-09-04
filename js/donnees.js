// Chargement des fichiers du dossier data/ et mise en cache.
//
// Le format des fichiers est "colonnaire" : une liste de noms de champs, puis
// des tableaux de valeurs. C'est environ 45 % plus compact que des objets
// repetes. Ce module se charge de le retransformer en objets lisibles.

const cacheVentes = new Map();
const chargementsEnCours = new Map();

// Delai avant la nouvelle tentative automatique. Court : il ne sert qu'a
// laisser passer une micro-coupure, pas a attendre un serveur en panne.
const ATTENTE_NOUVELLE_TENTATIVE = 250;

const attendre = (ms) => new Promise((resoudre) => setTimeout(resoudre, ms));

/**
 * Fabrique une erreur QUALIFIEE. Le "genre" est ce qui permet de distinguer
 * une commune sans vente d'une vraie panne -- distinction dont depend
 * l'honnetete de l'estimation (voir chargerVentes).
 */
function erreurDonnees(chemin, statut, genre, message) {
  return Object.assign(new Error(message), { chemin, statut, genre });
}

async function lireJson(chemin) {
  let reponse;
  try {
    reponse = await fetch(chemin, { cache: "no-cache" });
  } catch (cause) {
    // fetch ne rejette que si la requete n'a pas pu partir ou aboutir :
    // pas de reseau, serveur injoignable, connexion coupee.
    throw erreurDonnees(chemin, 0, "reseau",
      "Impossible de joindre le serveur (" + chemin + ")");
  }
  if (!reponse.ok) {
    // 404 : le fichier n'existe pas. Pour les ventes, c'est NORMAL et attendu.
    // Tout autre statut est une panne, et doit le rester.
    throw erreurDonnees(chemin, reponse.status,
      reponse.status === 404 ? "absent" : "serveur",
      "Fichier introuvable : " + chemin + " (" + reponse.status + ")");
  }
  try {
    return await reponse.json();
  } catch (cause) {
    throw erreurDonnees(chemin, reponse.status, "illisible",
      "Fichier illisible, probablement tronque : " + chemin);
  }
}

/** Transforme {champs, valeurs} en une liste d'objets. */
function enObjets(table) {
  return table.valeurs.map((ligne) => {
    const objet = {};
    table.champs.forEach((champ, i) => { objet[champ] = ligne[i]; });
    return objet;
  });
}

export async function chargerBase() {
  const [meta, communes, contours] = await Promise.all([
    lireJson("data/meta.json"),
    lireJson("data/communes.json"),
    lireJson("data/communes-geo.json"),
  ]);
  return { meta, communes: enObjets(communes), contours };
}

/**
 * Les communes limitrophes. Ce fichier ne sert QUE lorsqu'une estimation doit
 * s'elargir au-dela de la commune : inutile de le faire attendre au premier
 * affichage de la carte.
 */
export async function chargerAdjacence() {
  return lireJson("data/adjacence.json");
}

export async function chargerBandes(departement) {
  return lireJson("data/bandes-" + departement + ".json");
}

/**
 * L'annuaire des voies : « libelle de voie -> communes ou elle existe ».
 *
 * Il pese 0,8 Mo compresse, soit deux fois le chargement initial complet du
 * site. Il n'est donc JAMAIS telecharge au demarrage : seulement le jour ou
 * l'on tape une adresse sans avoir choisi de ville. La promesse est gardee,
 * pas le resultat : deux frappes rapprochees ne declenchent qu'un seul
 * telechargement, et un echec n'est pas mis en cache -- on pourra reessayer.
 */
let annuaireEnCours = null;

export async function chargerVoies() {
  if (!annuaireEnCours) {
    annuaireEnCours = lireJson("data/voies.json").catch((erreur) => {
      annuaireEnCours = null;
      throw erreur;
    });
  }
  return annuaireEnCours;
}

function decoderVentes(table, codeCommune) {
  return table.ventes.map((ligne) => {
    const vente = {};
    table.champs.forEach((champ, i) => { vente[champ] = ligne[i]; });
    vente.code = codeCommune;
    return vente;
  });
}

/**
 * Telecharge les ventes d'une commune.
 *
 * Regle essentielle : SEUL un 404 signifie « cette commune n'a aucune vente ».
 * Une panne reseau, une erreur serveur ou un fichier tronque doivent remonter.
 * Sinon l'estimateur croirait la commune vide, s'elargirait aux communes
 * voisines, et rendrait une estimation degradee sans le dire -- exactement ce
 * que cette application s'interdit ailleurs.
 *
 * Une seule nouvelle tentative, pour absorber les micro-coupures sans faire
 * patienter l'utilisateur devant un serveur reellement en panne.
 */
async function telechargerVentes(codeCommune, departement) {
  const chemin = "data/ventes/" + departement + "/" + codeCommune + ".json";
  try {
    return decoderVentes(await lireJson(chemin), codeCommune);
  } catch (erreur) {
    if (erreur.genre === "absent") return [];
    await attendre(ATTENTE_NOUVELLE_TENTATIVE);
    try {
      return decoderVentes(await lireJson(chemin), codeCommune);
    } catch (secondeErreur) {
      if (secondeErreur.genre === "absent") return [];
      throw secondeErreur;
    }
  }
}

/**
 * Ventes d'une commune. Charge le fichier au premier appel seulement.
 * En cas d'echec, RIEN n'est mis en cache : une tentative ulterieure
 * retelechargera vraiment.
 */
export async function chargerVentes(codeCommune, departement) {
  if (cacheVentes.has(codeCommune)) return cacheVentes.get(codeCommune);
  if (chargementsEnCours.has(codeCommune)) return chargementsEnCours.get(codeCommune);

  const promesse = telechargerVentes(codeCommune, departement)
    .then((ventes) => {
      cacheVentes.set(codeCommune, ventes);
      return ventes;
    })
    .finally(() => chargementsEnCours.delete(codeCommune));

  chargementsEnCours.set(codeCommune, promesse);
  return promesse;
}
