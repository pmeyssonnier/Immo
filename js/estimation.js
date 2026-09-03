// ---------------------------------------------------------------------------
// L'ALGORITHME D'ESTIMATION
// ---------------------------------------------------------------------------
// Ce fichier ne touche jamais a la page web : il ne fait que des calculs. C'est
// volontaire, pour deux raisons :
//   1. on peut le tester automatiquement (voir tests/test_estimation.mjs) ;
//   2. on peut relire la methode sans se perdre dans du code d'affichage.
//
// Principe general : pour estimer une maison, on cherche les ventes reelles qui
// lui ressemblent le plus, on remet leur prix au niveau d'aujourd'hui, puis on
// prend la mediane du prix au m2 -- en donnant plus de poids aux ventes les plus
// comparables (meme commune, surface proche, vente recente).
// ---------------------------------------------------------------------------

export const REGLAGES = {
  // Poids selon l'endroit
  POIDS_MEME_COMMUNE: 1.0,
  POIDS_COMMUNE_VOISINE: 0.45,

  // Largeur de la cloche appliquee a l'ecart de surface (25 %)
  SIGMA_SURFACE: 0.25,
  // Au-dela de ce rapport de surface, la vente n'est plus comparable du tout
  ECART_SURFACE_MAX: 0.85,      // ln(2.34) : de S/2.34 a S x 2.34

  // Une vente perd 15 % de son poids par annee d'anciennete (demi-vie ~4,3 ans)
  DECROISSANCE_ANNUELLE: 0.85,
  // Chaque piece d'ecart coute 10 % de poids
  DECROISSANCE_PIECE: 0.90,
  // Le terrain est un critere secondaire : cloche volontairement tres large
  SIGMA_TERRAIN: 0.9,
  DECALAGE_TERRAIN: 300,        // evite ln(0) pour les maisons sans terrain

  // Combien de comparables faut-il pour ne pas elargir aux communes voisines ?
  MIN_COMPARABLES_BRUT: 8,
  MIN_TAILLE_EFFECTIVE: 12,
  // En dessous de ce seuil, on REFUSE d'annoncer un chiffre
  SEUIL_REFUS: 6,
  SEUIL_CONFIANCE_BONNE: 25,
  // Sous ce nombre de ventes dans la commune ELLE-MEME, la confiance est
  // plafonnee a "faible" : l'estimation repose alors surtout sur les voisines.
  MIN_VENTES_COMMUNE_PROPRE: 5,

  // Une fourchette ne descend jamais sous +/-4 % ni ne depasse +/-12 %
  FOURCHETTE_MIN: 0.04,
  FOURCHETTE_MAX: 0.12,

  // Ajustement terrain optionnel : au-dela, la valeur du terrain sature
  TERRAIN_AJUSTEMENT_MAX: 2500,

  NB_COMPARABLES_AFFICHES: 10,
};

// --- Petites fonctions mathematiques ---------------------------------------

/** Ramene une valeur entre deux bornes. */
export function borner(valeur, mini, maxi) {
  return Math.max(mini, Math.min(maxi, valeur));
}

/**
 * Indice de prix a une date donnee, interpole mois par mois.
 * Les indices sont annuels ; on les ancre au milieu de l'annee puis on trace
 * une droite entre deux ancres. Cela evite une marche d'escalier au 1er janvier.
 */
export function indiceInterpole(indicesAnnuels, t, anneeOrigine) {
  const ancres = Object.keys(indicesAnnuels)
    .map((annee) => [(Number(annee) - anneeOrigine) * 12 + 5.5, indicesAnnuels[annee]])
    .sort((a, b) => a[0] - b[0]);
  if (ancres.length === 0) return 1;
  if (ancres.length === 1 || t <= ancres[0][0]) return ancres[0][1];
  if (t >= ancres[ancres.length - 1][0]) return ancres[ancres.length - 1][1];
  for (let i = 0; i < ancres.length - 1; i += 1) {
    const [tA, vA] = ancres[i];
    const [tB, vB] = ancres[i + 1];
    if (t <= tB) return vA + ((vB - vA) * (t - tA)) / (tB - tA);
  }
  return ancres[ancres.length - 1][1];
}

/**
 * Quantiles ponderes, par interpolation lineaire.
 * On utilise la convention dite du "point median" : chaque vente occupe un
 * segment proportionnel a son poids, et on se place au milieu de ce segment.
 * C'est ce qui evite un biais systematique vers le bas ou vers le haut.
 */
export function quantilesPonderes(couples, quantiles) {
  const tries = couples.slice().sort((a, b) => a.valeur - b.valeur);
  const total = tries.reduce((somme, c) => somme + c.poids, 0);
  if (tries.length === 0 || total <= 0) return quantiles.map(() => null);

  const positions = [];
  let cumul = 0;
  for (const couple of tries) {
    cumul += couple.poids;
    positions.push((cumul - couple.poids / 2) / total);
  }

  return quantiles.map((q) => {
    if (q <= positions[0]) return tries[0].valeur;
    if (q >= positions[positions.length - 1]) return tries[tries.length - 1].valeur;
    for (let i = 0; i < positions.length - 1; i += 1) {
      if (q <= positions[i + 1]) {
        const part = (q - positions[i]) / (positions[i + 1] - positions[i]);
        return tries[i].valeur + part * (tries[i + 1].valeur - tries[i].valeur);
      }
    }
    return tries[tries.length - 1].valeur;
  });
}

/**
 * Taille d'echantillon efficace (formule de Kish).
 * 20 ventes dont une seule pese vraiment, cela ne vaut pas 20 ventes : cette
 * formule dit combien de ventes "pleines" l'echantillon represente reellement.
 */
export function tailleEffective(poids) {
  const somme = poids.reduce((a, b) => a + b, 0);
  const sommeCarres = poids.reduce((a, b) => a + b * b, 0);
  if (sommeCarres <= 0) return 0;
  return (somme * somme) / sommeCarres;
}

// --- Les cinq ponderations -------------------------------------------------

export function poidsGeo(estVoisine) {
  return estVoisine ? REGLAGES.POIDS_COMMUNE_VOISINE : REGLAGES.POIDS_MEME_COMMUNE;
}

/** Cloche gaussienne sur le RAPPORT des surfaces (et non leur difference). */
export function poidsSurface(surfaceVente, surfaceCible) {
  if (!surfaceVente || !surfaceCible) return 0;
  const ecart = Math.log(surfaceVente / surfaceCible) / REGLAGES.SIGMA_SURFACE;
  return Math.exp(-0.5 * ecart * ecart);
}

export function poidsTemps(tVente, tReference) {
  const annees = Math.max(0, (tReference - tVente) / 12);
  return Math.pow(REGLAGES.DECROISSANCE_ANNUELLE, annees);
}

export function poidsPieces(piecesVente, piecesCible) {
  if (!piecesCible || !piecesVente) return 1;
  return Math.pow(REGLAGES.DECROISSANCE_PIECE, Math.abs(piecesVente - piecesCible));
}

export function poidsTerrain(terrainVente, terrainCible) {
  if (terrainCible === null || terrainCible === undefined) return 1;
  const d = REGLAGES.DECALAGE_TERRAIN;
  const ecart = Math.log((terrainVente + d) / (terrainCible + d)) / REGLAGES.SIGMA_TERRAIN;
  return Math.exp(-0.5 * ecart * ecart);
}

// --- Preparation des comparables -------------------------------------------

/**
 * Transforme les ventes brutes en comparables ponderes et actualises.
 * `ventes` : [{t, prix, sbati, sterr, pieces, lat, lon, adresse, code, voisine}]
 */
export function preparerComparables(ventes, entree) {
  const { surface, terrain, pieces, tReference, indicesAnnuels, anneeOrigine } = entree;
  const indiceReference = indiceInterpole(indicesAnnuels, tReference, anneeOrigine);
  const comparables = [];

  for (const vente of ventes) {
    if (!vente.sbati || !vente.prix) continue;
    // Filtre dur : au-dela d'un rapport de 2,34 la comparaison n'a plus de sens
    if (Math.abs(Math.log(vente.sbati / surface)) > REGLAGES.ECART_SURFACE_MAX) continue;

    const indiceVente = indiceInterpole(indicesAnnuels, vente.t, anneeOrigine);
    const prixActualise = (vente.prix * indiceReference) / indiceVente;
    const prixM2 = prixActualise / vente.sbati;

    const details = {
      geo: poidsGeo(vente.voisine),
      surface: poidsSurface(vente.sbati, surface),
      temps: poidsTemps(vente.t, tReference),
      pieces: poidsPieces(vente.pieces, pieces),
      terrain: poidsTerrain(vente.sterr || 0, terrain),
    };
    const poids = details.geo * details.surface * details.temps
      * details.pieces * details.terrain;
    if (poids <= 0) continue;

    comparables.push({
      ...vente, prixActualise: Math.round(prixActualise), prixM2, poids, details,
    });
  }
  return comparables;
}

/** Arrondi "commercial" : un professionnel n'annonce pas 247 318 EUR. */
export function arrondirValeur(valeur) {
  if (!isFinite(valeur) || valeur <= 0) return 0;
  const pas = valeur >= 100000 ? 5000 : 1000;
  return Math.round(valeur / pas) * pas;
}

// --- L'estimation elle-meme ------------------------------------------------

/**
 * Estime une maison a partir d'une liste de comparables deja constituee.
 *
 * entree = {
 *   surface, terrain, pieces,          <- le bien a estimer
 *   ventes,                            <- comparables candidats
 *   tReference, indicesAnnuels, anneeOrigine,
 *   palier,                            <- 0 = commune seule, 1 = + voisines
 *   prixTerrain, ajusterTerrain
 * }
 */
export function estimer(entree) {
  const comparables = preparerComparables(entree.ventes || [], entree);
  const poids = comparables.map((c) => c.poids);
  const nEffectif = tailleEffective(poids);
  const nBrut = comparables.length;

  // Faut-il aller chercher les communes voisines ?
  const suffisant = nBrut >= REGLAGES.MIN_COMPARABLES_BRUT
    && nEffectif >= REGLAGES.MIN_TAILLE_EFFECTIVE;

  const nMemeCommune = comparables.filter((c) => !c.voisine).length;

  const base = {
    palier: entree.palier, nBrut, nEffectif, nMemeCommune, suffisant,
    comparables: comparables
      .slice()
      .sort((a, b) => b.poids - a.poids)
      .slice(0, REGLAGES.NB_COMPARABLES_AFFICHES),
  };

  // Pas assez de matiere : on refuse d'inventer un chiffre.
  if (nEffectif < REGLAGES.SEUIL_REFUS) {
    return { ...base, confiance: "insuffisante", valeur: null, fourchette: null };
  }

  const [q25, q50, q75] = quantilesPonderes(
    comparables.map((c) => ({ valeur: c.prixM2, poids: c.poids })),
    [0.25, 0.5, 0.75],
  );

  const valeur = q50 * entree.surface;
  const interquartile = q75 - q25;
  // Intervalle de confiance ~95 % de la mediane (encoche de boite a moustaches)
  const demiIC = (1.57 * interquartile * entree.surface) / Math.sqrt(nEffectif);
  const demiFourchette = borner(
    demiIC, REGLAGES.FOURCHETTE_MIN * valeur, REGLAGES.FOURCHETTE_MAX * valeur,
  );

  // La commune elle-meme doit avoir "parle" : une estimation portee uniquement
  // par les communes voisines ne merite jamais mieux que "faible", meme si les
  // voisines fournissent des centaines de ventes.
  const communeSAExprimee = nMemeCommune >= REGLAGES.MIN_VENTES_COMMUNE_PROPRE;
  let confiance = "faible";
  if (entree.palier === 0 && nEffectif >= REGLAGES.SEUIL_CONFIANCE_BONNE) confiance = "bonne";
  else if (nEffectif >= REGLAGES.MIN_TAILLE_EFFECTIVE && communeSAExprimee) confiance = "moyenne";

  // Ajustement terrain optionnel (decoche par defaut dans l'interface, car la
  // ponderation w_terrain corrige deja une partie de l'ecart).
  let ajustement = 0;
  if (entree.ajusterTerrain && entree.terrain !== null && comparables.length) {
    const terrains = comparables.map((c) => c.sterr || 0).sort((a, b) => a - b);
    const terrainMedian = terrains[Math.floor(terrains.length / 2)];
    const ecart = borner(entree.terrain - terrainMedian,
      -REGLAGES.TERRAIN_AJUSTEMENT_MAX, REGLAGES.TERRAIN_AJUSTEMENT_MAX);
    ajustement = ecart * (entree.prixTerrain || 0);
  }

  const valeurFinale = Math.max(0, valeur + ajustement);
  return {
    ...base,
    confiance,
    source: "comparables",
    prixM2Median: q50,
    prixM2Q1: q25,
    prixM2Q3: q75,
    ajustementTerrain: Math.round(ajustement),
    valeur: arrondirValeur(valeurFinale),
    valeurExacte: valeurFinale,
    fourchette: [
      arrondirValeur(Math.max(0, valeurFinale - demiFourchette)),
      arrondirValeur(valeurFinale + demiFourchette),
    ],
  };
}

/**
 * Dernier recours : la commune et ses voisines n'ont pas assez de ventes.
 * On se rabat sur les statistiques departementales par tranche de surface.
 * La confiance est alors forcement "faible", et l'interface doit le dire.
 */
export function estimerParBandes(entree) {
  const { bandes, surface } = entree;
  const ligne = ((bandes && bandes.valeurs) || []).find(
    (l) => surface >= l[0] && surface < l[1],
  );
  if (!ligne) {
    return {
      palier: 2, nBrut: 0, nEffectif: 0, suffisant: false,
      confiance: "insuffisante", valeur: null, fourchette: null, comparables: [],
    };
  }
  const [, , n, q1, median, q3] = ligne;
  const valeur = median * surface;
  return {
    palier: 2, nBrut: n, nEffectif: 0, suffisant: true,
    confiance: "faible", source: "bandes_departementales",
    prixM2Median: median, prixM2Q1: q1, prixM2Q3: q3,
    ajustementTerrain: 0,
    valeur: arrondirValeur(valeur),
    valeurExacte: valeur,
    fourchette: [
      arrondirValeur(valeur * (1 - REGLAGES.FOURCHETTE_MAX)),
      arrondirValeur(valeur * (1 + REGLAGES.FOURCHETTE_MAX)),
    ],
    comparables: [],
  };
}
