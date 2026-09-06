// Controles du harnais de backtest.
// Lancer avec :  node --test tests/test_backtest.mjs
//
// Un backtest ne vaut que par sa fidelite. Le harnais recalcule en JavaScript
// deux choses que le robot calcule en Python -- l'indice de prix annuel et les
// bandes departementales -- parce qu'il doit pouvoir les refaire SANS les annees
// futures. Une divergence entre les deux implementations fausserait tout, en
// silence.
//
// Ces tests exigent donc que, nourris de TOUTES les annees, les calculs du
// harnais reproduisent ce que le robot a publie : a l'identique pour l'indice,
// a 1 EUR pres pour les bandes -- l'ecart y est un arrondi, pas un desaccord,
// et le test dit pourquoi.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { calculerIndice, calculerBandes, chargerTout, backtester }
  from "../scripts/backtester.mjs";

const RACINE = join(dirname(fileURLToPath(import.meta.url)), "..");
const lire = (c) => JSON.parse(readFileSync(join(RACINE, c), "utf8"));

const MONDE = chargerTout();
const TOUTES = [];
for (const ventes of MONDE.parCommune.values()) TOUTES.push(...ventes);


test("l'indice de prix reproduit EXACTEMENT celui du robot", () => {
  const attendu = MONDE.meta.indice_prix;
  const obtenu = calculerIndice(TOUTES, MONDE.meta.annee_origine);

  let comparees = 0;
  for (const dep of Object.keys(attendu)) {
    for (const annee of Object.keys(attendu[dep])) {
      comparees += 1;
      assert.equal(obtenu[dep]?.[annee], attendu[dep][annee],
                   `indice ${dep}/${annee} : le harnais diverge du robot`);
    }
  }
  assert.ok(comparees > 100, `seulement ${comparees} valeurs comparées`);
  assert.deepEqual(Object.keys(obtenu).sort(), Object.keys(attendu).sort(),
                   "pas les mêmes départements des deux côtés");
});


test("les bandes de surface reproduisent celles du robot a 1 EUR pres", () => {
  // Pourquoi pas « exactement », contrairement a l'indice : le robot calcule ses
  // quantiles sur prix / surface NON ARRONDIS (preparer_donnees.py:609), alors
  // que les fichiers publies portent prix et sbati arrondis a l'entier. Le
  // harnais, qui ne dispose que du publie, ne peut pas retrouver la decimale
  // perdue.
  //
  // Mesure : 1 131 nombres identiques sur 1 134, et les trois autres differents
  // de 1 EUR/m2 sur des medianes voisines de 1 800 -- soit 0,06 %. Ces bandes ne
  // servent qu'au repli de palier 2 ; l'effet sur une estimation est nul.
  //
  // Le test reste un vrai garde-fou : il attraperait n'importe quelle divergence
  // ALGORITHMIQUE, qui se compterait en dizaines d'euros, pas en centimes.
  const parDep = new Map();
  for (const v of TOUTES) {
    if (!parDep.has(v.dep)) parDep.set(v.dep, []);
    parDep.get(v.dep).push(v);
  }
  let comparees = 0;
  let identiques = 0;
  for (const [dep, ventes] of parDep) {
    const chemin = `data/bandes-${dep}.json`;
    if (!existsSync(join(RACINE, chemin))) continue;
    const attendu = lire(chemin);
    const obtenu = calculerBandes(ventes);
    assert.deepEqual(obtenu.champs, attendu.champs);
    assert.equal(obtenu.valeurs.length, attendu.valeurs.length,
                 `département ${dep} : pas le même nombre de bandes`);
    for (let i = 0; i < attendu.valeurs.length; i += 1) {
      for (let j = 0; j < attendu.valeurs[i].length; j += 1) {
        const a = attendu.valeurs[i][j];
        const o = obtenu.valeurs[i][j];
        comparees += 1;
        if (a === o) identiques += 1;
        assert.ok(Math.abs(a - o) <= 1,
                  `bandes ${dep}, bande ${i}, colonne ${j} : robot ${a}, harnais ${o} `
                  + "— au-delà d'1 € ce n'est plus un arrondi mais une divergence");
      }
    }
  }
  assert.ok(comparees > 1000, `seulement ${comparees} nombres comparés`);
  assert.ok(identiques / comparees > 0.99,
            `seulement ${(100 * identiques / comparees).toFixed(2)} % d'identiques`);
});


test("sans passe, on ne peut rien estimer -- le harnais ne triche pas", () => {
  // Controle de bon sens a l'envers : si on ne garde que la PREMIERE annee comme
  // testable, il n'y a aucun passe, et le moteur doit refuser massivement. Un
  // harnais qui produirait quand meme des estimations laisserait fuir le present.
  const lignes = backtester({ monde: MONDE, taille: 300, graine: 7 });
  assert.ok(lignes.length > 0, "le backtest doit produire des lignes");
  for (const l of lignes) {
    assert.ok(l.annee >= 2023, `année ${l.annee} testée alors qu'elle manque de passé`);
  }
});


test("le tirage est reproductible : deux exécutions, le même échantillon", () => {
  const a = backtester({ monde: MONDE, taille: 200, graine: 42 });
  const b = backtester({ monde: MONDE, taille: 200, graine: 42 });
  assert.deepEqual(a.map((l) => l.code + "|" + l.reel), b.map((l) => l.code + "|" + l.reel));
  const c = backtester({ monde: MONDE, taille: 200, graine: 43 });
  assert.notDeepEqual(a.map((l) => l.reel), c.map((l) => l.reel),
                      "deux graines différentes doivent tirer des ventes différentes");
});


test("AUCUN comparable ne vient de l'annee testee ni des suivantes", () => {
  // Le controle qui compte, et il est STRUCTUREL : on regarde ce qui est
  // reellement remis au moteur, au lieu de l'inferer d'une statistique.
  //
  // Ma premiere version comparait l'erreur avec et sans fuite en esperant la voir
  // s'effondrer. Elle ne s'effondre pas -- 20,2 % contre 18,2 % --, et c'est
  // NORMAL : l'estimation est une mediane ponderee sur des centaines de
  // comparables, qu'une vente supplementaire, meme au poids maximal, ne peut pas
  // deplacer. Le test passait donc pour une mauvaise raison.
  const origine = MONDE.meta.annee_origine;
  const anneeDe = (t) => origine + Math.floor(t / 12);
  let vus = 0;
  backtester({
    monde: MONDE, taille: 400, graine: 11,
    espion: ({ vente, comparables, tReference }) => {
      vus += 1;
      assert.equal(tReference, vente.t,
                   "on doit estimer A LA DATE DE LA VENTE, pas à aujourd'hui");
      for (const c of comparables) {
        assert.ok(anneeDe(c.t) < anneeDe(vente.t),
                  `comparable de ${anneeDe(c.t)} utilisé pour une vente de `
                  + `${anneeDe(vente.t)} : fuite temporelle`);
        assert.notEqual(c.prix + "|" + c.t + "|" + c.sbati,
                        vente.prix + "|" + vente.t + "|" + vente.sbati,
                        "la vente testée figure dans ses propres comparables");
      }
    },
  });
  assert.ok(vus > 300, `seulement ${vus} estimations inspectées`);
});


test("en mode fuite, l'annee testee EST presente -- le drapeau agit vraiment", () => {
  const origine = MONDE.meta.annee_origine;
  const anneeDe = (t) => origine + Math.floor(t / 12);
  let contemporains = 0;
  backtester({
    monde: MONDE, taille: 400, graine: 11, avecFuite: true,
    espion: ({ vente, comparables }) => {
      contemporains += comparables.filter((c) => anneeDe(c.t) >= anneeDe(vente.t)).length;
    },
  });
  assert.ok(contemporains > 0,
            "avec --avec-fuite, des ventes contemporaines doivent apparaître ; "
            + "sinon le drapeau ne change rien et le garde-fou n'est pas testé");
});
