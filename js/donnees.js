// Chargement des fichiers du dossier data/ et mise en cache.
//
// Le format des fichiers est "colonnaire" : une liste de noms de champs, puis
// des tableaux de valeurs. C'est environ 45 % plus compact que des objets
// repetes. Ce module se charge de le retransformer en objets lisibles.

const cacheVentes = new Map();
const chargementsEnCours = new Map();

async function lireJson(chemin) {
  const reponse = await fetch(chemin, { cache: "no-cache" });
  if (!reponse.ok) throw new Error("Fichier introuvable : " + chemin + " (" + reponse.status + ")");
  return reponse.json();
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
  const [meta, communes, contours, adjacence] = await Promise.all([
    lireJson("data/meta.json"),
    lireJson("data/communes.json"),
    lireJson("data/communes-geo.json"),
    lireJson("data/adjacence.json"),
  ]);
  return { meta, communes: enObjets(communes), contours, adjacence };
}

export async function chargerBandes(departement) {
  return lireJson("data/bandes-" + departement + ".json");
}

/**
 * Ventes d'une commune. Charge le fichier au premier appel seulement :
 * les fois suivantes la reponse est immediate.
 */
export async function chargerVentes(codeCommune, departement) {
  if (cacheVentes.has(codeCommune)) return cacheVentes.get(codeCommune);
  if (chargementsEnCours.has(codeCommune)) return chargementsEnCours.get(codeCommune);

  const promesse = lireJson("data/ventes/" + departement + "/" + codeCommune + ".json")
    .then((table) => {
      const ventes = table.ventes.map((ligne) => {
        const vente = {};
        table.champs.forEach((champ, i) => { vente[champ] = ligne[i]; });
        vente.code = codeCommune;
        return vente;
      });
      cacheVentes.set(codeCommune, ventes);
      return ventes;
    })
    .catch(() => {
      // Une commune sans aucune vente n'a pas de fichier : ce n'est pas une erreur.
      cacheVentes.set(codeCommune, []);
      return [];
    })
    .finally(() => chargementsEnCours.delete(codeCommune));

  chargementsEnCours.set(codeCommune, promesse);
  return promesse;
}
