// Tests du chargement des données.
//
// Le point sensible : une commune sans aucune vente n'a PAS de fichier, et son
// 404 est normal. Mais une panne réseau, une erreur serveur ou un fichier
// tronqué ne doivent surtout pas être pris pour « cette commune n'a rien
// vendu » — sinon l'estimateur élargit aux communes voisines en silence et
// rend une estimation dégradée en la présentant comme normale.
//
// Lancer avec :  node --test tests/test_donnees.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { chargerVentes } from "../js/donnees.js";

const VENTES_VALIDES = {
  code: "30189",
  champs: ["t", "prix", "sbati", "sterr", "pieces", "lat", "lon", "adresse"],
  ventes: [[71, 265000, 110, 420, 4, 43.83, 4.36, "12 RUE DES LICES"]],
};

/** Remplace fetch et compte les appels. */
function simulerReseau(reponse) {
  const appels = [];
  globalThis.fetch = async (chemin) => {
    appels.push(chemin);
    return reponse(chemin, appels.length);
  };
  return appels;
}

const ok = (corps) => ({ ok: true, status: 200, json: async () => corps });
const statut = (code) => ({ ok: false, status: code, json: async () => ({}) });

test("404 = commune sans vente : liste vide, pas d'erreur", async () => {
  simulerReseau(() => statut(404));
  assert.deepEqual(await chargerVentes("11001", "11"), []);
});

test("erreur serveur : on refuse de faire semblant", async () => {
  const appels = simulerReseau(() => statut(500));
  await assert.rejects(() => chargerVentes("11002", "11"),
    (e) => e.genre === "serveur",
    "un 500 doit remonter, pas devenir une liste vide");
  assert.equal(appels.length, 2, "une seule nouvelle tentative automatique");
});

test("panne réseau : on refuse de faire semblant", async () => {
  simulerReseau(() => { throw new TypeError("Failed to fetch"); });
  await assert.rejects(() => chargerVentes("11003", "11"), (e) => e.genre === "reseau");
});

test("fichier tronqué : on refuse de faire semblant", async () => {
  simulerReseau(() => ({ ok: true, status: 200,
    json: async () => { throw new SyntaxError("Unexpected end of JSON input"); } }));
  await assert.rejects(() => chargerVentes("11004", "11"), (e) => e.genre === "illisible");
});

test("un échec n'est pas mis en cache : la fois suivante réessaie vraiment", async () => {
  let echouer = true;
  simulerReseau(() => (echouer ? statut(503) : ok(VENTES_VALIDES)));
  await assert.rejects(() => chargerVentes("11005", "11"));
  echouer = false;
  const ventes = await chargerVentes("11005", "11");
  assert.equal(ventes.length, 1, "après la panne, une nouvelle tentative doit aboutir");
});

test("la nouvelle tentative automatique rattrape une coupure passagère", async () => {
  const appels = simulerReseau((_c, n) => (n === 1 ? statut(502) : ok(VENTES_VALIDES)));
  const ventes = await chargerVentes("11006", "11");
  assert.equal(ventes.length, 1, "l'utilisateur ne doit rien voir d'une micro-coupure");
  assert.equal(appels.length, 2);
});

test("les ventes sont bien décodées et portent leur code de commune", async () => {
  simulerReseau(() => ok(VENTES_VALIDES));
  const [vente] = await chargerVentes("30189", "30");
  assert.equal(vente.prix, 265000);
  assert.equal(vente.sbati, 110);
  assert.equal(vente.adresse, "12 RUE DES LICES");
  assert.equal(vente.code, "30189");
});

test("le cache évite un second téléchargement", async () => {
  const appels = simulerReseau(() => ok(VENTES_VALIDES));
  await chargerVentes("30190", "30");
  await chargerVentes("30190", "30");
  assert.equal(appels.length, 1);
});
