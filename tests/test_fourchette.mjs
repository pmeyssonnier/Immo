// Le garde-fou de la fourchette : elle doit TENIR CE QU'ELLE PROMET.
//
// Lancer avec :  node --test tests/test_fourchette.mjs
//
// POURQUOI CE FICHIER EXISTE. Pendant toute la vie du projet, la fourchette a
// annonce +/-4 a +/-12 % sans que personne ne verifie ce qu'elle couvrait
// vraiment. Le backtest a fini par le mesurer : 20,9 %. Le vrai prix tombait
// DEHORS quatre fois sur cinq, et rien dans le depot ne pouvait le signaler.
//
// Les tests de tests/test_estimation.mjs verifient que le moteur calcule COMME
// IL A ETE CONCU. Aucun ne pouvait dire que la conception elle-meme repondait a
// la mauvaise question -- l'ancien 1,57 x IQR / racine(n) est l'intervalle de
// confiance de la MEDIANE (« connait-on le prix au m2 moyen de la commune ? »),
// pas l'endroit ou tombe le prix d'un bien donne.
//
// Ce fichier ferme ce trou. Il ne verifie pas une formule : il REMESURE la
// promesse sur des ventes reelles, et il tombe en panne si elle redevient
// fausse -- pondérations retouchees, donnees changees, departement ajoute.
//
// C'est le test le plus lent du depot (il rejoue un backtest). C'est le prix a
// payer pour qu'une promesse affichee a un client ne puisse plus deriver en
// silence.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { REGLAGES, amplitude, estimer, estimerParBandes } from "../js/estimation.js";
import { chargerTout, backtester } from "../scripts/backtester.mjs";

const RACINE = join(dirname(fileURLToPath(import.meta.url)), "..");

// La promesse affichee, exprimee en pourcentage. Le libelle lisible vit dans
// REGLAGES.COUVERTURE_ANNONCEE ; un test plus bas verifie que les deux disent
// la meme chose.
const CIBLE = 67;

// Tolerance. Elle est large a dessein : l'echantillon de test est petit, et il
// contient les annees qui ont servi au calibrage, ce qui le rend un peu
// optimiste. Elle reste tres loin des 20,9 % de l'ancienne fourchette -- ce
// test aurait donc echoue bruyamment sur le code d'avant, et c'est ce qu'on lui
// demande.
const TOLERANCE = 7;

const INDICES = { 2021: 0.90, 2022: 0.94, 2023: 0.97, 2024: 0.99, 2025: 1.0 };
const ORIGINE = 2020;

function entree(ventes, options = {}) {
  return {
    surface: 100, terrain: 500, pieces: 4, ventes,
    tReference: 71, indicesAnnuels: INDICES, anneeOrigine: ORIGINE,
    palier: 0, prixTerrain: 20, ajusterTerrain: false, ...options,
  };
}

function ventesFictives(n, { prixM2 = 2000, voisine = false } = {}) {
  return Array.from({ length: n }, (_, i) => ({
    t: 68, prix: Math.round(prixM2 * 100) + i * 100, sbati: 100, sterr: 500,
    pieces: 4, adresse: "rue " + i, voisine,
  }));
}

/** Largeur de la fourchette rapportee a la valeur estimee. */
function largeurRelative(resultat) {
  return (resultat.fourchette[1] - resultat.fourchette[0]) / resultat.valeur;
}


// ---------------------------------------------------------------------------
// LE test : la promesse est-elle tenue sur des ventes reelles ?
// ---------------------------------------------------------------------------
test("la fourchette tient la promesse affichée, mesurée sur des ventes réelles", () => {
  const lignes = backtester({ monde: chargerTout(), taille: 6000, graine: 3 });
  const utiles = lignes.filter((l) => l.basse !== null && l.reel > 0);
  assert.ok(utiles.length > 4000, `seulement ${utiles.length} ventes exploitables`);

  const dedans = utiles.filter((l) => l.reel >= l.basse && l.reel <= l.haute);
  const couverture = 100 * dedans.length / utiles.length;

  assert.ok(couverture >= CIBLE - TOLERANCE,
    `la fourchette promet ${CIBLE} % et n'en tient que ${couverture.toFixed(1)} % : `
    + "elle ment à l'utilisateur. Relancer node scripts/calibrer_fourchette.mjs "
    + "et republier les coefficients de REGLAGES.FOURCHETTE.");

  // La borne haute compte autant : une fourchette qui couvre 95 % alors qu'elle
  // en annonce 67 est devenue si large qu'elle n'oriente plus aucune decision.
  assert.ok(couverture <= CIBLE + TOLERANCE,
    `la fourchette couvre ${couverture.toFixed(1)} % pour ${CIBLE} % promis : `
    + "trop large pour servir à quelque chose.");
});


// ---------------------------------------------------------------------------
// L'etiquette de fiabilite doit avoir une consequence visible
// ---------------------------------------------------------------------------
test("moins la fiabilité est bonne, plus la fourchette est large", () => {
  // C'est ce qui manquait le plus : l'ancienne fourchette donnait la MEME
  // largeur relative a une estimation « bonne » et a une « faible », et sa
  // couverture mesuree ne suivait meme pas l'ordre des etiquettes
  // (19,9 % / 23,5 % / 17,6 %). Le mot « Fiabilite » n'avait aucune traduction
  // a l'ecran.
  const bonne = estimer(entree(ventesFictives(30)));
  const moyenne = estimer(entree(
    ventesFictives(10).concat(ventesFictives(40, { voisine: true })),
    { palier: 1 },
  ));
  const faible = estimer(entree(
    ventesFictives(3).concat(ventesFictives(200, { voisine: true })),
    { palier: 1 },
  ));

  assert.equal(bonne.confiance, "bonne");
  assert.equal(moyenne.confiance, "moyenne");
  assert.equal(faible.confiance, "faible");

  assert.ok(largeurRelative(moyenne) > largeurRelative(bonne),
    `« moyenne » (${largeurRelative(moyenne).toFixed(3)}) doit être plus large que `
    + `« bonne » (${largeurRelative(bonne).toFixed(3)})`);
  assert.ok(largeurRelative(faible) > largeurRelative(moyenne),
    `« faible » (${largeurRelative(faible).toFixed(3)}) doit être plus large que `
    + `« moyenne » (${largeurRelative(moyenne).toFixed(3)})`);
});


test("le repli départemental est le plus large de tous", () => {
  // Le palier 2 porte l'etiquette « faible », mais son erreur mediane mesuree
  // est de 40 % contre 33 % pour un « faible » ordinaire : deux populations
  // derriere une meme etiquette, d'ou une entree de calibrage a part.
  const bandes = estimerParBandes({
    surface: 100,
    bandes: { champs: [], valeurs: [[70, 110, 400, 1500, 1900, 2400]] },
  });
  const faible = estimer(entree(
    ventesFictives(3).concat(ventesFictives(200, { voisine: true })),
    { palier: 1 },
  ));
  assert.equal(bandes.confiance, "faible");
  assert.ok(largeurRelative(bandes) > largeurRelative(faible),
    "les moyennes départementales par tranche de surface sont la source la moins "
    + "sûre : leur fourchette doit être la plus large");
});


// ---------------------------------------------------------------------------
// Coherences elementaires
// ---------------------------------------------------------------------------
test("la fourchette encadre toujours la valeur annoncée", () => {
  const cas = [
    estimer(entree(ventesFictives(30))),
    estimer(entree(ventesFictives(10).concat(ventesFictives(40, { voisine: true })),
      { palier: 1 })),
    estimerParBandes({ surface: 100,
      bandes: { champs: [], valeurs: [[70, 110, 400, 1500, 1900, 2400]] } }),
  ];
  for (const r of cas) {
    assert.ok(r.fourchette[0] < r.valeur && r.valeur < r.fourchette[1],
      `fourchette ${r.fourchette} n'encadre pas ${r.valeur}`);
    assert.ok(r.fourchette[0] > 0, "une borne basse négative n'a aucun sens");
  }
});


test("chaque niveau de confiance chiffrable a ses coefficients", () => {
  // Un niveau oublie dans la table donnerait un « undefined » silencieux au
  // moment de deballer [bas, haut], donc une fourchette NaN a l'ecran.
  for (const cle of ["bonne", "moyenne", "faible", "bandes"]) {
    const coef = REGLAGES.FOURCHETTE[cle];
    assert.ok(Array.isArray(coef) && coef.length === 2, `coefficients manquants : ${cle}`);
    assert.ok(coef[0] > 0 && coef[0] < 1, `coefficient bas invalide pour ${cle} : ${coef[0]}`);
    assert.ok(coef[1] > 1, `coefficient haut invalide pour ${cle} : ${coef[1]}`);
  }
});


test("la fourchette penche vers le bas -- elle absorbe le biais du moteur", () => {
  // Le moteur sur-evalue (biais moyen mesure : +14,7 %). Des coefficients cales
  // sur les rapports reel/estime observes rattrapent ce decalage au lieu de le
  // cacher. Quelqu'un qui « rangerait » la table en la recentrant sur
  // l'estimation annulerait cette correction sans s'en apercevoir.
  //
  // Le decalage se lit sur le centre GEOMETRIQUE (racine de bas x haut), parce
  // que les coefficients sont multiplicatifs. Ma premiere version de ce test
  // regardait le centre arithmetique : il vaut 0,998 pour « moyenne », si bien
  // que le test echouait sur des coefficients pourtant justes. Le centre
  // geometrique, lui, vaut 0,89 a 0,95 pour les quatre cles -- c'est la vraie
  // propriete, et elle est constante.
  for (const cle of ["bonne", "moyenne", "faible", "bandes"]) {
    const [bas, haut] = REGLAGES.FOURCHETTE[cle];
    const centre = Math.sqrt(bas * haut);
    assert.ok(centre < 0.99,
      `${cle} : fourchette centrée sur l'estimation (centre géométrique ${centre.toFixed(3)}). `
      + "Elle doit pencher vers le bas pour compenser la sur-évaluation du moteur. "
      + "Ces nombres viennent de scripts/calibrer_fourchette.mjs, pas d'un arrondi à la main.");
  }
});


// ---------------------------------------------------------------------------
// L'ecran et le moteur doivent dire la meme chose
// ---------------------------------------------------------------------------
test("la phrase affichée correspond à la couverture réellement calibrée", () => {
  // Sans ce controle, on pourrait changer les coefficients et laisser l'ecran
  // promettre l'ancienne frequence -- exactement le defaut qu'on repare.
  const attendus = { 50: "1 fois sur 2", 67: "2 fois sur 3", 80: "4 fois sur 5",
                     90: "9 fois sur 10" };
  assert.equal(REGLAGES.COUVERTURE_ANNONCEE, attendus[CIBLE],
    `les coefficients visent ${CIBLE} % mais l'écran annonce `
    + `« ${REGLAGES.COUVERTURE_ANNONCEE} »`);

  // Et le panneau doit lire la constante, pas recopier la phrase a la main.
  const source = readFileSync(join(RACINE, "js", "panneau-estimation.js"), "utf8");
  assert.ok(source.includes("COUVERTURE_ANNONCEE"),
    "js/panneau-estimation.js doit afficher REGLAGES.COUVERTURE_ANNONCEE plutôt "
    + "qu'une phrase recopiée, sinon les deux peuvent diverger");
});


// ---------------------------------------------------------------------------
// L'amplitude affichee remplace l'ancienne etiquette « Fiabilite »
// ---------------------------------------------------------------------------
test("l'amplitude affichée correspond exactement aux montants affichés", () => {
  // Elle est recalculee depuis la fourchette publiee, arrondi commercial
  // compris, plutot que lue dans REGLAGES.FOURCHETTE : c'est le seul moyen que
  // le pourcentage annonce soit celui des deux montants montres juste au-dessus.
  const cas = [
    estimer(entree(ventesFictives(30))),
    estimer(entree(ventesFictives(10).concat(ventesFictives(40, { voisine: true })),
      { palier: 1 })),
    estimerParBandes({ surface: 100,
      bandes: { champs: [], valeurs: [[70, 110, 400, 1500, 1900, 2400]] } }),
  ];
  for (const r of cas) {
    const { bas, haut } = amplitude(r);
    assert.equal(bas, Math.round(100 * (r.fourchette[0] / r.valeur - 1)));
    assert.equal(haut, Math.round(100 * (r.fourchette[1] / r.valeur - 1)));
    assert.ok(bas < 0 && haut > 0,
      `amplitude ${bas} / ${haut} : elle doit encadrer l'estimation`);
  }
});


test("le repli départemental annonce SA propre amplitude, pas celle de « faible »", () => {
  // Le piege que ce test ferme : le repli porte l'etiquette de confiance
  // « faible » mais utilise les coefficients « bandes », nettement plus larges.
  // Une amplitude lue dans la table par la confiance afficherait donc -42 / +47
  // sous une fourchette reellement calculee a -52 / +65. Le chiffre annonce
  // contredirait les montants affiches deux lignes plus haut.
  const bandes = estimerParBandes({ surface: 100,
    bandes: { champs: [], valeurs: [[70, 110, 400, 1500, 1900, 2400]] } });
  const faible = estimer(entree(
    ventesFictives(3).concat(ventesFictives(200, { voisine: true })), { palier: 1 }));

  assert.equal(bandes.confiance, faible.confiance, "les deux portent bien la même étiquette");
  const large = amplitude(bandes);
  const etroite = amplitude(faible);
  assert.ok(large.haut > etroite.haut + 5 && large.bas < etroite.bas - 5,
    `amplitudes trop proches : bandes ${large.bas}/${large.haut}, `
    + `faible ${etroite.bas}/${etroite.haut} — le repli doit annoncer la sienne`);
});


test("aucune estimation chiffrée ne peut afficher une amplitude vide", () => {
  // Un « null » ici produirait « Amplitude : null » a l'ecran.
  const cas = [
    estimer(entree(ventesFictives(30))),
    estimerParBandes({ surface: 100,
      bandes: { champs: [], valeurs: [[70, 110, 400, 1500, 1900, 2400]] } }),
  ];
  for (const r of cas) assert.ok(amplitude(r), "amplitude introuvable pour un cas chiffré");
  // Et le refus, lui, n'a pas d'amplitude du tout -- c'est voulu.
  assert.equal(amplitude(estimer(entree([]))), null);
});


test("l'écran n'affiche plus le mot « Fiabilité » suivi d'un niveau", () => {
  const source = readFileSync(join(RACINE, "js", "panneau-estimation.js"), "utf8");
  assert.ok(source.includes("Amplitude"),
    "le panneau doit afficher l'amplitude");
  assert.ok(!/Fiabilité&nbsp;: <strong>/.test(source),
    "l'étiquette « Fiabilité : Bonne » doit avoir cédé la place à l'amplitude");
});
