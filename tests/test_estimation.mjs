// Tests de l'algorithme d'estimation.
// Lancer avec :  node --test tests/
//
// On importe le VRAI fichier js/estimation.js (pas une copie) : ce qui est
// teste ici est exactement ce qui tourne dans le navigateur.

import test from "node:test";
import assert from "node:assert/strict";
import {
  REGLAGES, arrondirValeur, borner, estimer, estimerParBandes, indiceInterpole,
  poidsPieces, poidsSurface, poidsTemps, poidsTerrain, preparerComparables,
  quantilesPonderes, tailleEffective,
} from "../js/estimation.js";

const INDICES = { 2021: 0.90, 2022: 0.94, 2023: 0.97, 2024: 0.99, 2025: 1.0 };
const ORIGINE = 2020;
const T_REF = 71;            // decembre 2025

/** Construit une entree d'estimation complete a partir de quelques ventes. */
function entree(ventes, options = {}) {
  return {
    surface: 100, terrain: 500, pieces: 4, ventes,
    tReference: T_REF, indicesAnnuels: INDICES, anneeOrigine: ORIGINE,
    palier: 0, prixTerrain: 20, ajusterTerrain: false, ...options,
  };
}

/** Fabrique n ventes similaires autour d'un prix au m2 donne. */
function ventesFictives(n, { prixM2 = 2000, sbati = 100, t = 68, sterr = 500, pieces = 4 } = {}) {
  return Array.from({ length: n }, (_, i) => ({
    t, prix: Math.round(prixM2 * sbati) + i * 100, sbati, sterr, pieces,
    adresse: "rue " + i, voisine: false,
  }));
}

// ---------------------------------------------------------------------------
test("quantiles ponderes : a poids egaux, la mediane vaut la mediane classique", () => {
  const couples = [100, 200, 300, 400].map((valeur) => ({ valeur, poids: 1 }));
  const [q25, q50, q75] = quantilesPonderes(couples, [0.25, 0.5, 0.75]);
  assert.equal(q50, 250);            // mediane classique de [100,200,300,400]
  assert.equal(q25, 150);            // calcule a la main (convention point median)
  assert.equal(q75, 350);
});

test("quantiles ponderes : un poids fort tire la mediane vers lui", () => {
  // valeurs 100 (poids 3) et 200 (poids 1) -> positions 0,375 et 0,875
  // q=0,5 tombe a 25 % du chemin entre les deux -> 125
  const [mediane] = quantilesPonderes(
    [{ valeur: 100, poids: 3 }, { valeur: 200, poids: 1 }], [0.5],
  );
  assert.equal(mediane, 125);
});

test("quantiles ponderes : liste vide -> null (et surtout pas 0)", () => {
  assert.deepEqual(quantilesPonderes([], [0.5]), [null]);
});

// ---------------------------------------------------------------------------
test("taille effective : egale au nombre de ventes quand les poids sont egaux", () => {
  assert.equal(tailleEffective([1, 1, 1, 1]), 4);
  assert.equal(tailleEffective([0.5, 0.5, 0.5, 0.5]), 4);
});

test("taille effective : s'effondre quand une seule vente domine", () => {
  const n = tailleEffective([10, 1, 1, 1]);
  assert.ok(n < 2, `attendu < 2, obtenu ${n}`);
  assert.ok(n > 1);
});

// ---------------------------------------------------------------------------
test("poids du temps : une vente de 5 ans pese 0,85^5", () => {
  assert.ok(Math.abs(poidsTemps(T_REF - 60, T_REF) - Math.pow(0.85, 5)) < 1e-12);
  assert.equal(poidsTemps(T_REF, T_REF), 1);
});

test("poids de la surface : symetrique en proportion, pas en difference", () => {
  // 80 m2 face a 100 m2 doit peser exactement comme 125 m2 face a 100 m2
  assert.ok(Math.abs(poidsSurface(80, 100) - poidsSurface(125, 100)) < 1e-12);
  assert.equal(poidsSurface(100, 100), 1);
  assert.ok(poidsSurface(80, 100) > poidsSurface(60, 100));
});

test("poids du terrain : une maison sans terrain ne casse pas le calcul", () => {
  const p = poidsTerrain(0, 500);
  assert.ok(p > 0 && p <= 1 && Number.isFinite(p));
});

test("poids des pieces : neutre si le nombre de pieces est inconnu", () => {
  assert.equal(poidsPieces(4, null), 1);
  assert.equal(poidsPieces(null, 4), 1);
  assert.ok(Math.abs(poidsPieces(6, 4) - 0.81) < 1e-12);
});

// ---------------------------------------------------------------------------
test("indice de prix : exact sur les ancres, lineaire entre elles", () => {
  const milieu2024 = (2024 - ORIGINE) * 12 + 5.5;
  assert.equal(indiceInterpole(INDICES, milieu2024, ORIGINE), 0.99);
  const entreDeux = indiceInterpole(INDICES, milieu2024 + 6, ORIGINE);
  assert.ok(entreDeux > 0.99 && entreDeux < 1.0, "interpolation absente entre 2024 et 2025");
  // hors bornes : on plafonne au lieu d'extrapoler n'importe quoi
  assert.equal(indiceInterpole(INDICES, 0, ORIGINE), 0.90);
  assert.equal(indiceInterpole(INDICES, 500, ORIGINE), 1.0);
});

test("actualisation : une vente ancienne est ramenee au niveau d'aujourd'hui", () => {
  const vente = { t: (2021 - ORIGINE) * 12 + 5, prix: 180000, sbati: 100, sterr: 500, pieces: 4 };
  const [c] = preparerComparables([vente], entree([]));
  // indice 2021 = 0,90 ; indice de reference = 1,0 -> +11 % environ
  assert.ok(c.prixActualise > 198000 && c.prixActualise < 202000,
    `prix actualise inattendu : ${c.prixActualise}`);
});

// ---------------------------------------------------------------------------
test("filtre dur : une vente de surface trop eloignee est ecartee", () => {
  const proches = preparerComparables(ventesFictives(1, { sbati: 100 }), entree([]));
  const lointaines = preparerComparables(ventesFictives(1, { sbati: 300 }), entree([]));
  assert.equal(proches.length, 1);
  assert.equal(lointaines.length, 0, "300 m2 face a 100 m2 doit etre exclu");
});

// ---------------------------------------------------------------------------
test("REFUS de chiffrer quand les donnees sont insuffisantes", () => {
  const resultat = estimer(entree([]));
  assert.equal(resultat.confiance, "insuffisante");
  assert.equal(resultat.valeur, null, "aucun chiffre ne doit etre annonce");
  assert.equal(resultat.fourchette, null);
});

test("REFUS aussi avec 3 ventes seulement", () => {
  const resultat = estimer(entree(ventesFictives(3)));
  assert.equal(resultat.confiance, "insuffisante");
  assert.equal(resultat.valeur, null);
});

test("estimation normale : valeur, fourchette et confiance coherentes", () => {
  const resultat = estimer(entree(ventesFictives(30, { prixM2: 2000 })));
  assert.equal(resultat.confiance, "bonne");
  assert.equal(resultat.source, "comparables");
  assert.ok(resultat.valeur > 180000 && resultat.valeur < 220000,
    `valeur inattendue : ${resultat.valeur}`);
  const [bas, haut] = resultat.fourchette;
  assert.ok(bas < resultat.valeur && resultat.valeur < haut, "fourchette mal ordonnee");
});

test("la fourchette ne descend jamais sous +/-4 %", () => {
  // 30 ventes identiques : dispersion nulle, donc IC theorique nul
  const resultat = estimer(entree(ventesFictives(30, { prixM2: 2000 })));
  const demi = (resultat.fourchette[1] - resultat.fourchette[0]) / 2;
  assert.ok(demi >= 0.035 * resultat.valeur,
    "une fourchette trop etroite donnerait une fausse impression de precision");
});

test("la fourchette ne depasse jamais +/-12 %", () => {
  const dispersees = [900, 1400, 1900, 2400, 2900, 3400, 3900, 4400, 4900, 5400,
    1000, 1500, 2000, 2500, 3000, 3500, 4000, 4500, 5000, 5500]
    .map((prixM2, i) => ({ t: 68, prix: prixM2 * 100, sbati: 100, sterr: 500,
      pieces: 4, adresse: "r" + i, voisine: false }));
  const resultat = estimer(entree(dispersees));
  const demi = (resultat.fourchette[1] - resultat.fourchette[0]) / 2;
  assert.ok(demi <= 0.125 * resultat.valeur + 5000,
    "au-dela de +/-12 % la fourchette n'aide plus personne");
});

test("confiance degradee quand on a du elargir aux communes voisines", () => {
  const ventes = ventesFictives(30).map((v) => ({ ...v, voisine: true }));
  const resultat = estimer(entree(ventes, { palier: 1 }));
  assert.notEqual(resultat.confiance, "bonne",
    "le palier 1 ne doit jamais donner une confiance 'bonne'");
});

test("monotonie : une maison plus grande vaut plus cher", () => {
  // marche ou le prix au m2 baisse quand la surface augmente (cas reel)
  const marche = [];
  for (const [sbati, prixM2] of [[70, 2400], [90, 2250], [110, 2100], [130, 1980],
    [150, 1880], [170, 1800], [200, 1700], [80, 2320], [100, 2180], [120, 2040],
    [140, 1930], [160, 1840], [180, 1760], [95, 2210], [115, 2070]]) {
    marche.push({ t: 68, prix: sbati * prixM2, sbati, sterr: 600, pieces: 4,
      adresse: "x", voisine: false });
  }
  const petite = estimer(entree(marche, { surface: 80 }));
  const grande = estimer(entree(marche, { surface: 160 }));
  assert.ok(grande.valeurExacte > petite.valeurExacte, "la grande doit valoir plus");
  assert.ok(grande.valeurExacte < 2 * petite.valeurExacte,
    "doubler la surface ne double pas le prix : le prix au m2 baisse");
});

test("ajustement terrain : plus de terrain, plus de valeur, mais plafonne", () => {
  const ventes = ventesFictives(30, { sterr: 500 });
  const sans = estimer(entree(ventes, { terrain: 500, ajusterTerrain: false }));
  const avec = estimer(entree(ventes, { terrain: 3000, ajusterTerrain: true }));
  const enorme = estimer(entree(ventes, { terrain: 50000, ajusterTerrain: true }));
  assert.ok(avec.valeurExacte > sans.valeurExacte);
  // plafonne a 2500 m2 d'ecart x 20 EUR = 50 000 EUR au maximum
  assert.ok(enorme.ajustementTerrain <= 50000 + 1,
    `ajustement non plafonne : ${enorme.ajustementTerrain}`);
});

// ---------------------------------------------------------------------------
test("repli departemental quand la commune et ses voisines sont vides", () => {
  const bandes = { champs: [], valeurs: [[90, 110, 4210, 1600, 1900, 2300]] };
  const resultat = estimerParBandes({ bandes, surface: 100 });
  assert.equal(resultat.palier, 2);
  assert.equal(resultat.confiance, "faible", "le repli n'inspire jamais une grande confiance");
  assert.equal(resultat.valeur, 190000);
  assert.deepEqual(resultat.comparables, [], "aucun comparable individuel a montrer");
});

test("repli departemental : surface hors de toute bande -> aucun chiffre", () => {
  const bandes = { champs: [], valeurs: [[90, 110, 100, 1600, 1900, 2300]] };
  const resultat = estimerParBandes({ bandes, surface: 500 });
  assert.equal(resultat.confiance, "insuffisante");
  assert.equal(resultat.valeur, null);
});

// ---------------------------------------------------------------------------
test("arrondi commercial", () => {
  assert.equal(arrondirValeur(247318), 245000);
  assert.equal(arrondirValeur(82400), 82000);
  assert.equal(arrondirValeur(0), 0);
  assert.equal(arrondirValeur(NaN), 0);
});

test("borner", () => {
  assert.equal(borner(5, 1, 3), 3);
  assert.equal(borner(0, 1, 3), 1);
  assert.equal(borner(2, 1, 3), 2);
});

test("les comparables sont classes du plus pertinent au moins pertinent", () => {
  const ventes = [
    ...ventesFictives(10, { sbati: 100, t: 68 }),      // tres pertinents
    ...ventesFictives(10, { sbati: 150, t: 12 }),      // moins pertinents
  ];
  const resultat = estimer(entree(ventes));
  const poids = resultat.comparables.map((c) => c.poids);
  assert.deepEqual(poids, poids.slice().sort((a, b) => b - a));
  assert.ok(resultat.comparables.length <= REGLAGES.NB_COMPARABLES_AFFICHES);
});

test("une estimation portee par les seules communes voisines reste 'faible'", () => {
  // 3 ventes dans la commune, 200 chez les voisines : meme si le volume total
  // est enorme, la commune elle-meme n'a presque rien dit.
  const ventes = [
    ...ventesFictives(3).map((v) => ({ ...v, voisine: false })),
    ...ventesFictives(200).map((v) => ({ ...v, voisine: true })),
  ];
  const resultat = estimer(entree(ventes, { palier: 1 }));
  assert.ok(resultat.nEffectif > 50, "le volume brut est pourtant important");
  assert.equal(resultat.nMemeCommune, 3);
  assert.equal(resultat.confiance, "faible",
    "annoncer 'moyenne' ici donnerait une fausse assurance a l'agent");
});

test("avec assez de ventes locales, l'elargissement donne bien 'moyenne'", () => {
  const ventes = [
    ...ventesFictives(10).map((v) => ({ ...v, voisine: false })),
    ...ventesFictives(40).map((v) => ({ ...v, voisine: true })),
  ];
  const resultat = estimer(entree(ventes, { palier: 1 }));
  assert.equal(resultat.confiance, "moyenne");
});
