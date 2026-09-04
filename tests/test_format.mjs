// Tests de la mise en forme, et surtout de l'échappement HTML.
// Lancer avec :  node --test tests/test_format.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { echapper, etoiles, eurosParM2, moisEnTexte, nombre, sansAccents, surface }
  from "../js/format.js";

// ---------------------------------------------------------------------------
// echapper : la seule barrière entre une saisie et le HTML de la page.
// ---------------------------------------------------------------------------

test("echapper neutralise les caractères qui ouvrent du balisage", () => {
  const attaque = '<img src=x onerror="alert(1)">';
  const resultat = echapper(attaque);
  for (const caractere of ["<", ">", '"']) {
    assert.ok(!resultat.includes(caractere),
      `« ${caractere} » subsiste dans « ${resultat} » : le balisage reste ouvrable`);
  }
  // le texte reste lisible : on échappe, on ne supprime pas
  assert.ok(resultat.includes("img"), "le texte tapé doit rester visible par l'utilisateur");
});

test("echapper traite l'esperluette EN PREMIER", () => {
  // Si & était échappé après <, "&lt;" deviendrait "&amp;lt;" et s'afficherait
  // littéralement. L'ordre des remplacements n'est donc pas indifférent.
  assert.equal(echapper("<"), "&lt;");
  assert.equal(echapper("&"), "&amp;");
  assert.equal(echapper("&lt;"), "&amp;lt;");
});

test("echapper protège aussi les valeurs d'attribut", () => {
  // title="${nomDep}" : une apostrophe ou un guillemet fermerait l'attribut.
  const resultat = echapper(`" onmouseover="alert(1)`);
  assert.ok(!resultat.includes('"'), "un guillemet fermerait l'attribut");
  assert.ok(!echapper("l'Isle").includes("'"), "une apostrophe fermerait un attribut simple");
});

test("echapper laisse les accents et les noms de communes intacts", () => {
  for (const nom of ["Nîmes", "Alès", "Vallon-Pont-d'Arc", "Pont-Saint-Esprit", "Uzès"]) {
    const resultat = echapper(nom);
    assert.ok(!resultat.includes("<") && !resultat.includes(">"));
    // seule l'apostrophe est transformée ; les accents ne bougent pas
    assert.equal(resultat.replace(/&#39;/g, "'"), nom);
  }
});

test("echapper accepte null, undefined et les nombres sans planter", () => {
  assert.equal(echapper(null), "");
  assert.equal(echapper(undefined), "");
  assert.equal(echapper(0), "0");
  assert.equal(echapper(1250), "1250");
});

// ---------------------------------------------------------------------------
// Les formateurs existants : ils ne produisent jamais de balisage.
// ---------------------------------------------------------------------------

test("les formateurs ne peuvent pas produire de balisage", () => {
  // C'est ce qui autorise à les interpoler sans les échapper.
  const sorties = [nombre(1234567), eurosParM2(2381), surface(120),
                   moisEnTexte(50, 2020), etoiles(0.8)];
  for (const sortie of sorties) {
    assert.ok(!/[<>]/.test(sortie), `« ${sortie} » contient du balisage`);
  }
});

test("les formateurs restent robustes aux valeurs manquantes", () => {
  assert.equal(nombre(null), "—");
  assert.equal(eurosParM2(undefined), "—");
  assert.equal(surface(null), "—");
});


// ---------------------------------------------------------------------------
// sansAccents : la brique de toute la recherche, et elle n'etait pas testee.
// ---------------------------------------------------------------------------

test("sansAccents enleve les accents et la casse", () => {
  for (const [avec, sans] of [["Nîmes", "nimes"], ["Alès", "ales"], ["Uzès", "uzes"],
                              ["Ardèche", "ardeche"], ["Hérault", "herault"],
                              ["Bouches-du-Rhône", "bouches-du-rhone"],
                              ["Pyrénées-Orientales", "pyrenees-orientales"],
                              ["Èze", "eze"], ["Oô", "oo"], ["Lançon", "lancon"]]) {
    assert.equal(sansAccents(avec), sans, `« ${avec} »`);
  }
});

test("sansAccents ne touche NI aux separateurs NI a la ponctuation", () => {
  // C'est justement ce qu'elle ne fait pas qui a rendu js/recherche.js
  // necessaire : « Pont Saint Esprit » ne trouvait pas « Pont-Saint-Esprit ».
  assert.equal(sansAccents("Pont-Saint-Esprit"), "pont-saint-esprit");
  assert.equal(sansAccents("L'Isle-sur-la-Sorgue"), "l'isle-sur-la-sorgue");
  assert.notEqual(sansAccents("Pont Saint Esprit"), sansAccents("Pont-Saint-Esprit"));
});

test("sansAccents accepte l'absence de texte", () => {
  for (const rien of [null, undefined, ""]) assert.equal(sansAccents(rien), "");
});
