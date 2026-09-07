// Tests de la recherche d'adresses.
// Lancer avec :  node --test tests/test_adresses.mjs
//
// Comme pour la recherche de communes, tout tourne sur les VRAIES donnees : les
// adresses DVF sont abregees d'une facon qu'aucun jeu invente ne reproduirait
// (« CHE DE LA MARJOLAINE », « ACH ANCIEN CHEMIN DE SALERNES », « CAE DEI
// TOURDRE »), et c'est precisement ce qu'il faut savoir retrouver.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { adresseLisible, chercherVentes, chercherVoies, indexerVoies, normaliserAdresse,
         ressembleAUneAdresse, LIMITE_ADRESSES } from "../js/adresses.js";

const RACINE = join(dirname(fileURLToPath(import.meta.url)), "..");
const lire = (chemin) => JSON.parse(readFileSync(join(RACINE, chemin), "utf8"));

function enObjets(table, cle = "valeurs") {
  return table[cle].map((ligne) => {
    const objet = {};
    table.champs.forEach((champ, i) => { objet[champ] = ligne[i]; });
    return objet;
  });
}

const COMMUNES = enObjets(lire("data/communes.json"));
const PAR_CODE = new Map(COMMUNES.map((c) => [c.code, c]));
const VOIES = indexerVoies(lire("data/voies.json"));
const VENTES_NIMES = enObjets(lire("data/ventes/30/30189.json"), "ventes");


// --------------------------------------------------------------------------
// La normalisation des adresses
// --------------------------------------------------------------------------

test("les abreviations DVF se developpent", () => {
  for (const [abrege, complet] of [["CHE DE LA MARJOLAINE", "chemin de la marjolaine"],
                                   ["RTE DE COURBESSAC", "route de courbessac"],
                                   ["AV JEAN JAURES", "avenue jean jaures"],
                                   ["IMP DES LILAS", "impasse des lilas"],
                                   ["ALL ALBERT DUBOUT", "allee albert dubout"],
                                   ["BD GAMBETTA", "boulevard gambetta"],
                                   ["PL DE LA MAIRIE", "place de la mairie"]]) {
    assert.equal(normaliserAdresse(abrege).colle, normaliserAdresse(complet).colle,
                 `« ${abrege} » doit rejoindre « ${complet} »`);
  }
});

test("les abreviations verifiees une par une sur les donnees", () => {
  // Chacune a ete relevee dans data/ventes/ avant d'entrer dans la table.
  for (const [abrege, complet] of [["ACH ANCIEN CHEMIN DE SALERNES", "ancien chemin ancien chemin de salernes"],
                                   ["RPT ROBERT SCHUMAN", "rond point robert schuman"],
                                   ["VC PETITE CORNICHE", "voie communale petite corniche"],
                                   ["CAE DEI TOURDRE", "carraire dei tourdre"],
                                   ["TSSE DU SOLEIL", "terrasse du soleil"],
                                   ["MTE DES OLIVIERS", "montee des oliviers"]]) {
    assert.equal(normaliserAdresse(abrege).colle, normaliserAdresse(complet).colle, abrege);
  }
});

test("les abreviations qui ne s'expliquent jamais toutes seules", () => {
  // Celles-ci ne sont JAMAIS suivies de leur propre sens dans les donnees --
  // « RLE DE LA ... », « CTRE LES HAUTS ... », « ART DE MORMOIRON ». Sans la
  // table, taper « ruelle », « centre » ou « ancienne route » ne trouvait rien.
  //
  // A l'inverse GR et VTE ont ete ECARTES : releve sur les 365 316 adresses,
  // ils sont toujours suivis de leur developpement (« GR GRAND RUE », « VTE
  // VIEILLE ROUTE »), donc ces voies se trouvaient deja. Les ajouter n'aurait
  // fait que dupliquer le texte indexe.
  for (const [abrege, complet] of [["RLE DE L EGLISE", "ruelle de l eglise"],
                                   ["RLE SAINT MARTIN", "ruelle saint martin"],
                                   ["CTRE LES HAUTS DE NIMES", "centre les hauts de nimes"]]) {
    assert.equal(normaliserAdresse(abrege).colle, normaliserAdresse(complet).colle, abrege);
  }
  // ART est suivi tantot de son sens, tantot de rien : la voie doit se trouver
  // dans les deux cas.
  const cherche = (indexee, saisie) => {
    const a = normaliserAdresse(indexee);
    return normaliserAdresse(saisie).mots.every((mot) => a.colle.includes(mot));
  };
  assert.ok(cherche("ART DE MORMOIRON", "ancienne route de mormoiron"),
            "« ART DE MORMOIRON » doit se trouver en tapant « ancienne route »");
  assert.ok(cherche("ART ANC RTE ST PAUL EN FORET", "ancienne route saint paul"));
});

test("« GR » est une abreviation, « grande » n'est pas un signal", () => {
  // Releve initial sur 14 departements : GR etait TOUJOURS suivi de son propre
  // sens (« GR GRAND RUE »), donc inutile. L'arrivee de Rhone-Alpes a dementi
  // ce constat : on y trouve « GR RUE DE LA ... » 579 fois, sans developpement.
  const trouve = (indexee, saisie) => {
    const a = normaliserAdresse(indexee);
    return normaliserAdresse(saisie).mots.every((mot) => a.colle.includes(mot));
  };
  assert.ok(trouve("GR RUE DE LA REPUBLIQUE", "grande rue de la republique"),
            "« GR RUE DE LA ... » doit se trouver en tapant « grande rue »");
  assert.ok(trouve("GR GRANDE RUE", "grande rue"), "la forme deja developpee reste trouvable");
  assert.ok(trouve("GR GRAND RUE", "grand rue"));

  // MAIS « grande » ne doit PAS faire basculer la recherche en mode adresse :
  // c'est un developpement, pas un signal. Deux communes portent ce mot, dont
  // La Grande-Motte ; les traiter comme des adresses telechargerait l'annuaire
  // (1,5 Mo) pour un simple nom de ville.
  for (const ville of ["La Grande-Motte", "Peyrusse-Grande", "grande"]) {
    assert.ok(!ressembleAUneAdresse(ville), `« ${ville} » n'est pas une adresse`);
  }
  // En revanche « grande rue » en est bien une, grace a « rue ».
  assert.ok(ressembleAUneAdresse("grande rue de la republique"));
});

test("les noms de communes ne deviennent pas des adresses", () => {
  // Garde-fou : « ruelle » et « centre » entrent dans le vocabulaire des voies.
  // Aucune commune ne doit basculer du cote « adresse » a cause de ca, sinon la
  // recherche de villes changerait de mode toute seule.
  for (const ville of ["La Grand-Combe", "Le Grand-Serre", "La Bâtie-Vieille",
                       "Château-Ville-Vieille", "Vieille-Toulouse"]) {
    assert.ok(!ressembleAUneAdresse(ville), `« ${ville} » reste une commune`);
  }
});

test("le numero de voirie est mis de côté, pas mélangé au nom", () => {
  assert.equal(normaliserAdresse("12 RUE AMPERE").numero, "12");
  assert.equal(normaliserAdresse("12 RUE AMPERE").colle, normaliserAdresse("RUE AMPERE").colle);
  assert.equal(normaliserAdresse("12 B RUE AMPERE").colle, normaliserAdresse("b rue ampere").colle);
  assert.equal(normaliserAdresse("RUE AMPERE").numero, null);
  // Un nombre au milieu n'est pas un numero de voirie.
  assert.equal(normaliserAdresse("RUE DU 8 MAI").numero, null);
});

test("on reconnait une adresse d'un nom de ville", () => {
  for (const adresse of ["12 rue Ampère", "rue du docteur Paradis", "chemin de la Marjolaine",
                         "3038 route de Courbessac", "impasse des Lilas", "av jean jaures"]) {
    assert.ok(ressembleAUneAdresse(adresse), `« ${adresse} » est une adresse`);
  }
  for (const ville of ["Nîmes", "ale", "Pont-Saint-Esprit", "Gard", "30", "uzes", "la garde"]) {
    assert.ok(!ressembleAUneAdresse(ville), `« ${ville} » n'est pas une adresse`);
  }
});


// --------------------------------------------------------------------------
// Chercher dans une commune deja ouverte : on obtient les ventes
// --------------------------------------------------------------------------

test("une rue de Nîmes donne ses ventes, avec leur prix", () => {
  const trouves = chercherVentes(VENTES_NIMES, "rue du docteur Paradis");
  assert.ok(trouves.length >= 2, "cette rue compte plusieurs ventes");
  for (const { vente } of trouves) {
    assert.match(vente.adresse, /DOCTEUR PARADIS/);
    assert.ok(vente.prix > 0, "un résultat est une vente réelle, avec son prix");
    assert.ok(vente.sbati > 0);
  }
});

test("l'abréviation marche dans les deux sens sur les vraies ventes", () => {
  const parAbrege = chercherVentes(VENTES_NIMES, "CHE DE RUSSAN");
  const parComplet = chercherVentes(VENTES_NIMES, "chemin de Russan");
  assert.ok(parComplet.length > 0, "« chemin de Russan » doit trouver des ventes");
  assert.deepEqual(parComplet.map((r) => r.indice), parAbrege.map((r) => r.indice));
});

test("le numéro exact remonte en tête, sans masquer le reste de la rue", () => {
  const rue = chercherVentes(VENTES_NIMES, "rue du docteur Paradis");
  const numeros = rue.map((r) => normaliserAdresse(r.vente.adresse).numero);
  assert.ok(numeros.includes("12"), "le 12 existe dans cette rue");

  const cible = chercherVentes(VENTES_NIMES, "12 rue du docteur Paradis");
  assert.equal(normaliserAdresse(cible[0].vente.adresse).numero, "12",
               "le numéro demandé doit arriver en premier");
  assert.equal(cible.length, rue.length,
               "les autres numéros de la rue restent visibles, pour comparer");
});

test("les accents et la casse sont facultatifs", () => {
  const a = chercherVentes(VENTES_NIMES, "AVENUE JEAN JAURES");
  const b = chercherVentes(VENTES_NIMES, "avenue jean jaurès");
  assert.ok(a.length > 0);
  assert.deepEqual(b.map((r) => r.indice), a.map((r) => r.indice));
});

test("une adresse inconnue ne renvoie rien, et rien ne plante", () => {
  assert.deepEqual(chercherVentes(VENTES_NIMES, "rue qui n'existe pas du tout"), []);
  assert.deepEqual(chercherVentes(VENTES_NIMES, ""), []);
  assert.doesNotThrow(() => chercherVentes(VENTES_NIMES, "((([\\"));
});


// --------------------------------------------------------------------------
// Chercher sans commune choisie : l'annuaire des voies
// --------------------------------------------------------------------------

test("l'annuaire trouve une voie et dit dans quelle commune elle est", () => {
  const trouves = chercherVoies(VOIES, "rue du docteur Paradis", PAR_CODE);
  assert.ok(trouves.length > 0);
  const nimes = trouves.find((r) => r.commune.code === "30189");
  assert.ok(nimes, "Nîmes doit figurer parmi les communes proposées");
  assert.match(nimes.voie, /DOCTEUR PARADIS/);
});

test("préciser la ville écarte les homonymes de rue", () => {
  const partout = chercherVoies(VOIES, "avenue Jean Jaurès", PAR_CODE, Infinity);
  const communes = new Set(partout.map((r) => r.commune.code));
  assert.ok(communes.size > 5, "« avenue Jean Jaurès » existe dans beaucoup de communes");

  const cible = chercherVoies(VOIES, "avenue Jean Jaurès Nîmes", PAR_CODE, Infinity);
  assert.ok(cible.length > 0);
  assert.ok(cible.every((r) => r.commune.code === "30189"),
            "en nommant la ville, on ne doit obtenir qu'elle");
});

test("l'annuaire comprend les abréviations comme la saisie complète", () => {
  const abrege = chercherVoies(VOIES, "che de la Marjolaine Nîmes", PAR_CODE, Infinity);
  const complet = chercherVoies(VOIES, "chemin de la Marjolaine Nîmes", PAR_CODE, Infinity);
  assert.ok(complet.length > 0);
  assert.deepEqual(complet.map((r) => r.voie + r.commune.code),
                   abrege.map((r) => r.voie + r.commune.code));
});

test("le classement met la correspondance exacte devant", () => {
  const trouves = chercherVoies(VOIES, "rue Ampère Nîmes", PAR_CODE, Infinity);
  assert.ok(trouves.length > 0);
  for (let i = 1; i < trouves.length; i += 1) {
    assert.ok(trouves[i - 1].rang <= trouves[i].rang, "classement désordonné");
  }
});

test("le plafond de résultats est respecté, et rien ne plante", () => {
  assert.ok(chercherVoies(VOIES, "rue", PAR_CODE).length <= LIMITE_ADRESSES);
  assert.deepEqual(chercherVoies(VOIES, "", PAR_CODE), []);
  assert.doesNotThrow(() => chercherVoies(VOIES, '<img src=x onerror="alert(1)">', PAR_CODE));
});

test("l'annuaire ne cite que des communes connues", () => {
  for (const { commune } of chercherVoies(VOIES, "rue de la République", PAR_CODE)) {
    assert.ok(PAR_CODE.has(commune.code), "code de commune inconnu dans l'annuaire");
  }
});


// ---------------------------------------------------------------------------
// adresseLisible : developper les abreviations POUR L'AFFICHAGE.
//
// A ne pas confondre avec normaliserAdresse, juste au-dessus, qui sert a
// COMPARER : celle-la detruit accents, apostrophes et espaces, et developpe deux
// fois quand DVF a deja ecrit le mot -- ce qui est voulu pour chercher, et
// interdit pour afficher.
//
// Chaque cas ci-dessous vient d'un releve sur les 591 835 adresses du depot,
// pas d'une intuition.
// ---------------------------------------------------------------------------
test("adresseLisible developpe le type de voie", () => {
  assert.equal(adresseLisible("51 CHE DU PATY"), "51 CHEMIN DU PATY");
  assert.equal(adresseLisible("94B RTE DE SAUVE"), "94B ROUTE DE SAUVE");
  assert.equal(adresseLisible("12 AV JEAN JAURES"), "12 AVENUE JEAN JAURES");
  assert.equal(adresseLisible("5128F VC CARRAIRE DE LA BELLE"),
               "5128F VOIE COMMUNALE CARRAIRE DE LA BELLE");
});

test("adresseLisible ne touche QUE le type de voie", () => {
  // 2 438 adresses contiennent une abreviation ailleurs qu'en tete, ou elle
  // n'en est pas une. Un remplacement partout les abimerait toutes.
  assert.equal(adresseLisible("5938 MAUX PAS"), "5938 MAUX PAS",
    "« PAS » est ici un lieu-dit, pas un passage");
  assert.equal(adresseLisible("29 IMP DES FLEURS VC 249"),
               "29 IMPASSE DES FLEURS VC 249",
    "le « VC 249 » final est un numero de voie communale, pas un type de voie");
  assert.equal(adresseLisible("7A RUE LE HAM DU CHAT VERT"), "7A RUE LE HAM DU CHAT VERT");
});

test("adresseLisible RETIRE l'abreviation quand DVF a deja ecrit le mot", () => {
  // Le cas majeur : GR est suivi de son propre developpement 1 864 fois sur
  // 2 060 (90,5 %). Le developper donnerait « GRANDE GRAND RUE ».
  assert.equal(adresseLisible("5286 GR GRAND RUE"), "5286 GRAND RUE");
  assert.equal(adresseLisible("GR GRANDE RUE"), "GRANDE RUE");
  assert.equal(adresseLisible("ACH ANCIEN CHEMIN DE SALERNES"), "ANCIEN CHEMIN DE SALERNES");
  assert.equal(adresseLisible("2346 VC VOIE COMMUNALE N 2"), "2346 VOIE COMMUNALE N 2");
  // Mais GR sans developpement doit bien etre developpe.
  assert.equal(adresseLisible("GR RUE DE LA REPUBLIQUE"), "GRANDE RUE DE LA REPUBLIQUE");
});

test("adresseLisible compare des MOTS ENTIERS, pas des prefixes", () => {
  // Piege trouve en mesurant : une premiere version comparait les debuts de
  // mots et prenait « COUREOU » pour « COURS ». C'est un nom provencal.
  assert.equal(adresseLisible("8 CRS COUREOU DA BANCA"), "8 COURS COUREOU DA BANCA");
});

test("adresseLisible laisse INTACT tout ce qu'elle ne reconnait pas", () => {
  // C'est la regle par defaut, pas une exception : 15,6 % des adresses sont des
  // lieux-dits, et l'annuaire des voies contient des libelles purement
  // numeriques et des abreviations hors table.
  for (const tel_quel of ["LE MAS DES VIGNES", "LES HAUTS DE NIMES", "10E QRT DES VIDELAS",
                          "1075", "SAINT JEAN DU GARD", "LA REGAGNADE - LA FONTAINE"]) {
    assert.equal(adresseLisible(tel_quel), tel_quel);
  }
});

test("adresseLisible franchit le numero de voirie, suffixe et ordinal compris", () => {
  assert.equal(adresseLisible("1ERE IMP DU PETIT FOUR"), "1ERE IMPASSE DU PETIT FOUR");
  assert.equal(adresseLisible("2E RTE DE TOULON"), "2E ROUTE DE TOULON");
  assert.equal(adresseLisible("94B RTE DE SAUVE"), "94B ROUTE DE SAUVE");
});

test("adresseLisible ne renvoie jamais undefined a l'ecran", () => {
  for (const rien of ["", "   ", null, undefined]) assert.equal(adresseLisible(rien), "");
});

test("adresseLisible garde les MAJUSCULES et n'invente pas d'accent", () => {
  // DVF est sans accents : « RUE DE L'EPERON », jamais « EPERON » accentue. Une
  // mise en casse normale donnerait « Rue de l'Eperon », de la prose francaise a
  // laquelle il manque ses accents. En capitales, leur absence est normale.
  const sortie = adresseLisible("24 RUE DE L'EPERON");
  assert.equal(sortie, "24 RUE DE L'EPERON");
  assert.ok(!/[éèêàçùôî]/.test(adresseLisible("11 ALL DES PINS")),
            "aucun accent ne doit apparaitre dans une adresse en capitales");
  assert.equal(adresseLisible("11 ALL DES PINS"), "11 ALLEE DES PINS");
});

test("adresseLisible ne change RIEN a la recherche", () => {
  // La table est partagee avec normaliserAdresse. Ce test fige le fait que les
  // deux fonctions restent independantes : l'affichage ne developpe qu'une fois,
  // la recherche developpe des deux cotes, y compris deux fois.
  assert.equal(normaliserAdresse("ACH ANCIEN CHEMIN DE SALERNES").colle,
               "anciencheminancienchemindesalernes",
               "la double expansion reste le comportement voulu cote recherche");
  assert.equal(normaliserAdresse("CHE DE RUSSAN").colle,
               normaliserAdresse("chemin de russan").colle);
});
