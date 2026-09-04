// Tests du suivi des demandes.
//
// C'est la pièce qui empêche une estimation lente pour la commune A de venir
// s'afficher sous le titre de la commune B.
// Lancer avec :  node --test tests/test_demandes.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { creerSuiviDeDemandes } from "../js/demandes.js";

test("la première demande est la plus récente tant qu'aucune autre ne part", () => {
  const suivi = creerSuiviDeDemandes();
  const jeton = suivi.nouvelle();
  assert.equal(suivi.estLaDerniere(jeton), true);
});

test("une demande plus récente périme la précédente", () => {
  const suivi = creerSuiviDeDemandes();
  const ancienne = suivi.nouvelle();
  const nouvelle = suivi.nouvelle();
  assert.equal(suivi.estLaDerniere(ancienne), false,
    "l'ancienne demande ne doit plus avoir le droit d'écrire un résultat");
  assert.equal(suivi.estLaDerniere(nouvelle), true);
});

test("le scénario réel : Nîmes puis Uzès, Nîmes finit en dernier", () => {
  const suivi = creerSuiviDeDemandes();
  const nimes = suivi.nouvelle();     // l'utilisateur demande Nîmes
  const uzes = suivi.nouvelle();      // il clique Uzès sans attendre
  // Nîmes termine APRÈS Uzès : c'est le cas qui produisait le bug
  assert.equal(suivi.estLaDerniere(nimes), false,
    "le résultat de Nîmes ne doit pas écraser celui d'Uzès");
  assert.equal(suivi.estLaDerniere(uzes), true);
});

test("deux estimations sur la MÊME commune : seule la dernière compte", () => {
  // 120 m² puis 200 m² sans attendre : le premier calcul ne doit pas gagner.
  const suivi = creerSuiviDeDemandes();
  const a120 = suivi.nouvelle();
  const a200 = suivi.nouvelle();
  assert.equal(suivi.estLaDerniere(a120), false);
  assert.equal(suivi.estLaDerniere(a200), true);
});

test("deux suivis sont indépendants", () => {
  const a = creerSuiviDeDemandes();
  const b = creerSuiviDeDemandes();
  const jetonA = a.nouvelle();
  b.nouvelle(); b.nouvelle();
  assert.equal(a.estLaDerniere(jetonA), true,
    "l'activité d'un autre suivi ne doit pas périmer celui-ci");
});

test("un jeton inventé n'est jamais reconnu", () => {
  const suivi = creerSuiviDeDemandes();
  suivi.nouvelle();
  assert.equal(suivi.estLaDerniere(0), false);
  assert.equal(suivi.estLaDerniere(999), false);
  assert.equal(suivi.estLaDerniere(undefined), false);
});
