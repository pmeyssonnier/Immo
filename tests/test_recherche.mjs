// Tests de la recherche de communes.
// Lancer avec :  node --test tests/test_recherche.mjs
//
// Ces tests tournent sur les VRAIES donnees de data/communes.json, et non sur
// un echantillon fabrique. C'est voulu : les cas difficiles de ce sujet sont
// tous des noms reels -- « Lez » qui est a la fois une commune de Haute-Garonne
// et un separateur dans « Saint-Christol-lez-Ales », les quatre « La Garde »
// dans quatre departements, « Py » qui ne fait que deux lettres. Un jeu de test
// invente n'aurait contenu aucun d'eux.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { chercher, indexerCommunes, normaliser, LIMITE_RESULTATS, RANG }
  from "../js/recherche.js";

const RACINE = join(dirname(fileURLToPath(import.meta.url)), "..");

function chargerCommunes() {
  const table = JSON.parse(readFileSync(join(RACINE, "data", "communes.json"), "utf8"));
  return table.valeurs.map((ligne) => {
    const commune = {};
    table.champs.forEach((champ, i) => { commune[champ] = ligne[i]; });
    return commune;
  });
}

const COMMUNES = chargerCommunes();
const INDEX = indexerCommunes(COMMUNES);

/** Les noms trouves, dans l'ordre du classement. */
function noms(saisie, combien = 5) {
  return chercher(INDEX, saisie).slice(0, combien).map((r) => r.commune.nom);
}

/** Le premier resultat, ou null. */
function premier(saisie) {
  const resultats = chercher(INDEX, saisie);
  return resultats.length ? resultats[0].commune : null;
}


// --------------------------------------------------------------------------
// La normalisation
// --------------------------------------------------------------------------

test("les separateurs disparaissent : espace, tiret, apostrophe droite ou courbe", () => {
  const attendu = "pontsaintesprit";
  for (const forme of ["Pont-Saint-Esprit", "Pont Saint Esprit", "pont saint esprit",
                       "PONT-SAINT-ESPRIT", "Pont.Saint.Esprit", "Pont—Saint—Esprit"]) {
    assert.equal(normaliser(forme).colle, attendu,
                 `« ${forme} » doit se reduire a la meme forme que le nom officiel`);
  }
  assert.equal(normaliser("L'Isle-sur-la-Sorgue").colle, normaliser("L’Isle sur la Sorgue").colle,
               "l'apostrophe typographique et la droite doivent se valoir");
});

test("St devient Saint, et Ste devient Sainte", () => {
  assert.equal(normaliser("St-Esprit").colle, "saintesprit");
  assert.equal(normaliser("Ste Cecile").colle, "saintececile");
  assert.deepEqual(normaliser("St Jean").mots, ["saint", "jean"]);
});

test("l'abreviation ne s'applique qu'au mot entier", () => {
  // Le vrai risque de cette regle : transformer un nom qui commence par ces
  // deux lettres. Aucune commune des quatorze departements n'est dans ce cas,
  // mais la regle doit tenir quand meme.
  assert.equal(normaliser("Stains").colle, "stains", "« Stains » n'est pas « Saintains »");
  assert.equal(normaliser("Steenvoorde").colle, "steenvoorde");
  assert.equal(normaliser("Sternes").mots[0], "sternes");
});

test("une saisie vide, ou faite de separateurs seuls, ne cherche rien", () => {
  for (const rien of ["", "   ", "---", "'", "  - . ' "]) {
    assert.deepEqual(chercher(INDEX, rien), [], `« ${rien} » ne doit rien renvoyer`);
  }
});


// --------------------------------------------------------------------------
// Les cas demandes par l'utilisateur, mot pour mot
// --------------------------------------------------------------------------

test("« Ales » et « Alès » trouvent Ales en premier", () => {
  for (const saisie of ["Ales", "Alès", "ALES", "alès", " ales "]) {
    assert.equal(premier(saisie).nom, "Alès", `« ${saisie} » doit donner Ales en tete`);
  }
});

test("trois lettres suffisent : « ale » met Ales en premier", () => {
  // C'etait le defaut le plus penible : Ales arrivait en 33e position sur 60,
  // derriere L'Escale, L'Hospitalet, Valensole, Valernes et Saleon.
  assert.equal(premier("ale").nom, "Alès");
  assert.equal(premier("al").nom, "Alès", "deux lettres aussi");
  assert.equal(premier("nim").nom, "Nîmes");
  assert.equal(premier("uze").nom, "Uzès");
});

test("« Pont Saint Esprit » trouve Pont-Saint-Esprit, quelle que soit l'ecriture", () => {
  for (const saisie of ["Pont Saint Esprit", "Pont-Saint-Esprit", "pontsaintesprit",
                        "St Esprit", "pont st esprit", "PONT SAINT ESPRIT"]) {
    const trouve = premier(saisie);
    assert.ok(trouve, `« ${saisie} » ne doit pas rester sans resultat`);
    assert.equal(trouve.nom, "Pont-Saint-Esprit", `« ${saisie} »`);
  }
});

test("« L'Isle sur la Sorgue » trouve L'Isle-sur-la-Sorgue", () => {
  for (const saisie of ["L'Isle sur la Sorgue", "L Isle sur la Sorgue",
                        "l’isle sur la sorgue", "lisle sur la sorgue"]) {
    assert.equal(premier(saisie).nom, "L'Isle-sur-la-Sorgue", `« ${saisie} »`);
  }
});


// --------------------------------------------------------------------------
// Le classement
// --------------------------------------------------------------------------

test("le nom exact passe devant tout le reste", () => {
  const resultats = chercher(INDEX, "Ales");
  assert.equal(resultats[0].rang, RANG.EXACT);
  assert.equal(resultats[0].commune.nom, "Alès");
  // Les communes voisines (Brouzet-les-Ales, Mejannes-les-Ales) suivent, mais
  // apres : leur nom ne fait que contenir « ales ».
  assert.ok(resultats[1].rang > RANG.EXACT, "aucune autre commune ne peut etre exacte ici");
});

test("a rang egal, la commune la plus vendue passe devant", () => {
  // C'est ce qui met Ales (plus de mille ventes) devant Alenya et
  // Alet-les-Bains, qui commencent aussi par « ale ».
  const resultats = chercher(INDEX, "ale").filter((r) => r.rang === RANG.DEBUT);
  assert.ok(resultats.length >= 3, "« ale » doit donner plusieurs debuts de nom");
  for (let i = 1; i < resultats.length; i += 1) {
    assert.ok(resultats[i - 1].commune.n >= resultats[i].commune.n,
              "les ventes doivent decroitre a l'interieur d'un rang");
  }
});

test("les rangs ne peuvent que croitre dans la liste rendue", () => {
  for (const saisie of ["ale", "saint", "la garde", "30", "gard", "pont"]) {
    const rangs = chercher(INDEX, saisie).map((r) => r.rang);
    for (let i = 1; i < rangs.length; i += 1) {
      assert.ok(rangs[i - 1] <= rangs[i], `« ${saisie} » : classement desordonne`);
    }
  }
});

test("un mot au milieu d'un nom compose se trouve, et se classe pour ce qu'il est", () => {
  // « esprit » ne commence pas Pont-Saint-Esprit : il commence un de ses mots.
  // Le rang doit le dire, sans quoi ce resultat passerait devant une commune
  // dont le nom commence vraiment par ce qu'on a tape.
  const resultats = chercher(INDEX, "esprit");
  assert.equal(resultats[0].commune.nom, "Pont-Saint-Esprit");
  assert.equal(resultats[0].rang, RANG.MOTS_EN_DEBUT);
});

test("le classement est reproductible d'un appel a l'autre", () => {
  for (const saisie of ["ale", "saint", "la garde", "30"]) {
    const premier = chercher(INDEX, saisie).map((r) => r.commune.code);
    const second = chercher(indexerCommunes(COMMUNES), saisie).map((r) => r.commune.code);
    assert.deepEqual(second, premier, `« ${saisie} » doit donner deux fois le meme ordre`);
  }
});


// --------------------------------------------------------------------------
// Les noms difficiles, tous reels
// --------------------------------------------------------------------------

test("les communes homonymes sortent toutes, avec leur departement", () => {
  // Quatre-vingt-quinze noms sont portes par plusieurs communes. C'est la
  // raison d'etre de l'affichage du departement sur chaque ligne.
  const trouves = chercher(INDEX, "la garde").map((r) => r.commune);
  const gardes = trouves.filter((c) => c.nom === "La Garde");
  assert.ok(gardes.length >= 2, "« La Garde » existe dans plusieurs departements");
  const departements = new Set(gardes.map((c) => c.dep));
  assert.equal(departements.size, gardes.length, "chaque homonyme a son propre departement");
});

test("les noms tres courts se trouvent, et passent devant les noms qui les contiennent", () => {
  // « Py » fait deux lettres ; « Lez » est a la fois une commune de
  // Haute-Garonne et le separateur de « Saint-Christol-lez-Ales ».
  for (const [saisie, attendu] of [["py", "Py"], ["lez", "Lez"], ["gap", "Gap"],
                                   ["apt", "Apt"], ["eus", "Eus"], ["die", "Die"]]) {
    const trouve = premier(saisie);
    assert.equal(trouve.nom, attendu, `« ${saisie} » doit donner la commune elle-meme en tete`);
  }
});

test("les accents sont facultatifs dans les deux sens", () => {
  assert.equal(premier("nimes").nom, "Nîmes");
  assert.equal(premier("Nîmes").nom, "Nîmes");
  assert.equal(premier("ardeche") !== null, true);
  assert.equal(premier("uzes").nom, "Uzès");
});


// --------------------------------------------------------------------------
// Les departements et les codes INSEE
// --------------------------------------------------------------------------

test("un numero de departement liste ses communes, les plus vendues d'abord", () => {
  const resultats = chercher(INDEX, "30");
  assert.ok(resultats.length > 0);
  for (const { commune } of resultats) {
    assert.equal(commune.dep, "30", "« 30 » ne doit sortir que des communes du Gard");
  }
  assert.equal(resultats[0].commune.nom, "Nîmes", "la plus vendue du Gard d'abord");
});

test("un numero se reconnait sur deux chiffres exactement, sans deviner", () => {
  const surDeux = chercher(INDEX, "06", Infinity);
  assert.ok(surDeux.length > 100);
  assert.ok(surDeux.every((r) => r.commune.dep === "06"), "« 06 » designe les Alpes-Maritimes");

  // Completer « 6 » en « 06 » serait une devinette : on ne le fait pas. Ce qui
  // compte surtout, c'est que « 6 » ne ramene pas un departement PAR ERREUR --
  // il ramenait les 226 communes du 66, dont les codes INSEE commencent par 6.
  const surUnChiffre = chercher(INDEX, "6", Infinity);
  assert.ok(surUnChiffre.length < 10,
            `« 6 » doit rester anecdotique, or il donne ${surUnChiffre.length} resultats`);
  assert.ok(!surUnChiffre.some((r) => r.commune.dep === "66"),
            "« 6 » ne doit pas ramener les Pyrenees-Orientales");
});

test("un chiffre isole ne peut pas devenir un debut de code INSEE", () => {
  // « 3 » visait les 1285 communes du 30 et du 31 ; « 0 » en visait 1195.
  for (const chiffre of ["0", "1", "3", "4", "8"]) {
    const resultats = chercher(INDEX, chiffre, Infinity);
    assert.ok(resultats.length < 20,
              `« ${chiffre} » donne ${resultats.length} resultats, c'est un ratissage`);
  }
  // A partir de trois caracteres, en revanche, un debut de code a du sens.
  const parCode = chercher(INDEX, "301", Infinity);
  assert.ok(parCode.length > 0);
  assert.ok(parCode.every((r) => r.commune.code.startsWith("301")));
});

test("nommer un departement le liste en tete, les plus grosses villes d'abord", () => {
  // Onze communes du Gard portent « gard » dans leur nom -- Bagard, Bellegarde,
  // Rochefort-du-Gard... Se contenter de « des communes du Gard sont la »
  // passerait donc AUSSI avec l'ancienne recherche, qui ne connaissait pas les
  // departements. On exige une commune du Gard dont le nom ne dit rien du Gard.
  const resultats = chercher(INDEX, "gard");
  assert.equal(resultats[0].commune.nom, "Nîmes",
               "« Gard » doit donner Nimes, dont le nom ne contient pas « gard »");
  assert.equal(resultats[0].rang, RANG.DEPARTEMENT_NOMME);
});

test("nommer un departement bat un debut de nom qui n'a rien a voir", () => {
  // Le cas qui a fait changer l'ordre des rangs : « var » donnait Varilhes,
  // qui est en ARIEGE, avant Toulon. Nommer un departement est une intention
  // trop explicite pour se faire doubler par une coincidence de lettres.
  for (const [saisie, attendu] of [["var", "Toulon"], ["aude", "Carcassonne"],
                                   ["herault", "Béziers"], ["drome", "Montélimar"],
                                   ["vaucluse", "Avignon"], ["ariege", "Pamiers"]]) {
    assert.equal(premier(saisie).nom, attendu, `« ${saisie} »`);
  }
  // Varilhes reste trouvable, simplement plus bas.
  const varilhes = chercher(INDEX, "var", Infinity).find((r) => r.commune.nom === "Varilhes");
  assert.ok(varilhes, "Varilhes ne doit pas disparaitre");
  assert.equal(varilhes.rang, RANG.DEBUT);
});

test("un bout de nom de departement reste une piste, pas une intention", () => {
  // « garonne » ou « orientales » ne nomment pas un departement en entier :
  // ils le designent quand meme, mais tout en bas. Avant, ils ne le
  // designaient pas du tout -- « orientales » ne donnait aucun resultat.
  for (const [saisie, dep] of [["garonne", "31"], ["orientales", "66"], ["rhone", "13"]]) {
    const resultats = chercher(INDEX, saisie, Infinity);
    const duDep = resultats.filter((r) => r.commune.dep === dep);
    assert.ok(duDep.length > 50, `« ${saisie} » doit atteindre le departement ${dep}`);
    assert.ok(duDep.every((r) => r.rang === RANG.APPROCHANT || r.rang < RANG.APPROCHANT),
              "un bout de nom ne vaut pas une designation");
  }
});

test("« sainte » ne ramene pas les Saint-E...", () => {
  // Sur la forme collee, « saintesteve » et « saintemaxime » commencent tous
  // deux par « sainte » : dix-huit Saint-Etienne et Saint-Esteve se melaient
  // aux trente-trois vraies Sainte. C'est la frontiere de mot qui les separe.
  const resultats = chercher(INDEX, "sainte", Infinity);
  const enTete = resultats.filter((r) => r.rang === RANG.DEBUT_NET);
  assert.ok(enTete.length > 20, "il y a une trentaine de vraies Sainte-");
  for (const { commune } of enTete) {
    assert.match(commune.nom, /^Saintes?[- ]/,
                 `${commune.nom} n'est pas une Sainte, il ne doit pas etre en tete`);
    assert.ok(!/^Saint-[EÉ]/.test(commune.nom), `${commune.nom} est un Saint, pas une Sainte`);
  }
  // Saint-Esteve reste trouvable, plus bas.
  assert.ok(resultats.some((r) => r.commune.nom === "Saint-Estève"));
});

test("un code INSEE complet donne une seule commune", () => {
  const resultats = chercher(INDEX, "30189");
  assert.equal(resultats.length, 1);
  assert.equal(resultats[0].commune.nom, "Nîmes");
  assert.equal(resultats[0].rang, RANG.EXACT);
});


// --------------------------------------------------------------------------
// Robustesse
// --------------------------------------------------------------------------

test("le plafond de resultats est respecte", () => {
  // « a » touche presque tout : c'est le pire cas pour un telephone.
  assert.ok(chercher(INDEX, "a").length <= LIMITE_RESULTATS);
  assert.ok(chercher(INDEX, "saint").length <= LIMITE_RESULTATS);
  assert.equal(chercher(INDEX, "a", 5).length, 5, "la limite doit rester reglable");
});

test("une saisie qui ne correspond a rien renvoie une liste vide", () => {
  assert.deepEqual(chercher(INDEX, "zzzzzzqqq"), []);
  assert.deepEqual(chercher(INDEX, "99999"), []);
});

test("une tentative d'injection ne fait rien planter et ne trouve rien", () => {
  const attaque = '<img src=x onerror="document.title=\'XSS\'">';
  assert.deepEqual(chercher(INDEX, attaque), [],
                   "aucun nom de commune ne peut correspondre a cela");
  assert.doesNotThrow(() => chercher(INDEX, "((((["), "les caracteres speciaux ne sont pas du motif");
  assert.doesNotThrow(() => chercher(INDEX, "\\"));
});

test("chercher n'exige rien d'autre que les champs qu'il utilise", () => {
  // Garde-fou contre une dependance cachee au reste de l'objet commune.
  const minimal = indexerCommunes([{ code: "30189", nom: "Nîmes", dep: "30", n: 42 }]);
  assert.equal(chercher(minimal, "nimes")[0].commune.code, "30189");
});
