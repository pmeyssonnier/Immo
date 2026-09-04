// Verification de bout en bout : on ouvre reellement le site dans un navigateur
// et on refait les gestes de l'utilisateur.
//
// Ce test n'est PAS lance par l'integration continue (il demande un navigateur).
// Pour le lancer a la main :
//     npm install playwright-core
//     python3 -m http.server 8321 &
//     CHROME=/chemin/vers/chrome node tests/verification_navigateur.mjs
//
// Les captures d'ecran sont ecrites a cote, dans le dossier indique par SORTIE.

import { chromium } from "playwright-core";

const SP = process.env.SORTIE || ".";
const PORT = process.env.PORT || "8321";
// BASE permet de rejouer le cas de PRODUCTION, ou le site vit dans un
// sous-dossier (…/Immo/) et non a la racine du domaine. Sans cela, on ne
// testerait jamais la resolution reelle des chemins relatifs.
const BASE = process.env.BASE || "/";
const CHEMIN_CHROME = process.env.CHROME
  || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const erreurs = [];
let echecs = 0;
function verifier(ok, message) {
  console.log((ok ? "  OK   " : "  ECHEC") + "  " + message);
  if (!ok) echecs += 1;
}

const navigateur = await chromium.launch({
  executablePath: CHEMIN_CHROME,
  args: ["--no-sandbox"],
});
const page = await navigateur.newPage({ viewport: { width: 1440, height: 900 } });
page.on("pageerror", (e) => erreurs.push("pageerror: " + e.message));
page.on("console", (m) => { if (m.type() === "error") erreurs.push("console: " + m.text()); });

// Toute violation de la politique de sécurité du contenu est enregistrée :
// une CSP trop stricte casserait l'application en silence.
const violationsCsp = [];
await page.addInitScript(() => {
  window.__violationsCsp = [];
  document.addEventListener("securitypolicyviolation", (e) => {
    window.__violationsCsp.push(`${e.violatedDirective} ← ${e.blockedURI}`);
  });
});

// On capte l'instance de carte Leaflet SANS toucher a l'application : on
// intercepte l'affectation de window.L par la bibliotheque vendorisee, puis on
// enveloppe L.map. C'est le seul moyen de viser un point de vente au pixel
// pres, puisque les points sont peints sur un canvas et n'existent pas dans le
// DOM -- aucun selecteur ne peut les designer.
await page.addInitScript(() => {
  let bibliotheque;
  Object.defineProperty(window, "L", {
    configurable: true,
    get() { return bibliotheque; },
    set(valeur) {
      bibliotheque = valeur;
      if (valeur && valeur.map && !valeur.__captee) {
        const original = valeur.map;
        valeur.map = function (...args) {
          const instance = original.apply(this, args);
          window.__carte = instance;
          return instance;
        };
        Object.assign(valeur.map, original);
        valeur.__captee = true;
      }
    },
  });
});
await page.goto(`http://localhost:${PORT}${BASE}`, { waitUntil: "networkidle" });
await page.waitForSelector("#application:not([hidden])", { timeout: 20000 });

// --- 1. la liste des communes -------------------------------------------
// Les groupes sont repliés au démarrage : c'est le nombre de DÉPARTEMENTS qui
// doit être visible, pas 2 300 lignes de communes.
const groupes = await page.locator("#liste-communes details summary").allInnerTexts();
// On compare au nombre de départements réellement présents dans les données,
// plutôt qu'à un chiffre écrit en dur : ce test reste juste si on en ajoute.
const depsDansLesDonnees = await page.evaluate(async () => {
  const t = await (await fetch("data/communes.json")).json();
  const iDep = t.champs.indexOf("dep");
  return [...new Set(t.valeurs.map((l) => l[iDep]))].length;
});
verifier(groupes.length === depsDansLesDonnees,
  `${groupes.length} départements dans la liste (autant que dans les données)`);
// L'ordre affiché doit être exactement celui déclaré dans js/config.js.
// Un objet JavaScript rangeait les clés "11", "26"… avant "06" et "07" :
// ce contrôle est ce qui empêche ce piège de revenir.
const ordreAffiche = groupes.map((g) => g.split("\n")[0].trim());
const ordreAttendu = await page.evaluate(async () => {
  const texte = await (await fetch("js/config.js")).text();
  const bloc = texte.split("DEPARTEMENTS: [")[1].split("]")[0];
  return [...bloc.matchAll(/nom:\s*"([^"]+)"/g)].map((m) => m[1]);
});
verifier(ordreAffiche.join("|") === ordreAttendu.join("|"),
  ordreAffiche.join("|") === ordreAttendu.join("|")
    ? `ordre conforme à config.js : ${ordreAffiche.slice(0, 3).join(", ")}…`
    : `ordre affiché ${JSON.stringify(ordreAffiche)} au lieu de ${JSON.stringify(ordreAttendu)}`);
// Attention : un <details> replié GARDE ses lignes dans le DOM, il les masque
// seulement. C'est donc le nombre de lignes VISIBLES qu'il faut compter.
const communesVisibles = await page.locator("#liste-communes li:visible").count();
verifier(communesVisibles === 0,
  `au démarrage, aucune commune visible (${communesVisibles}) — liste courte et lisible`);
const dureeAffichage = await page.evaluate(() => {
  const t = performance.now();
  document.querySelector("#champ-recherche").value = "saint";
  document.querySelector("#champ-recherche").dispatchEvent(new Event("input"));
  return performance.now() - t;
});
verifier(dureeAffichage < 400,
  `réaffichage de la liste filtrée en ${dureeAffichage.toFixed(0)} ms`);
await page.fill("#champ-recherche", "");
await page.waitForTimeout(200);
// Les lignes de communes sont dans le DOM même quand leur groupe est replié :
// on peut donc les compter sans rien déplier.
const totalAnnonce = await page.locator("#liste-communes li").count();
// Chaque département doit afficher son prix médian sans qu'on ait rien à
// déplier : c'est la vue d'ensemble du marché.
const lignesDep = await page.locator("#liste-communes summary").allInnerTexts();
const sansPrix = lignesDep.filter((l) => !/\d[\d\u202f\u00a0 ]*€\/m²/.test(l));
verifier(sansPrix.length === 0, sansPrix.length
  ? `départements sans prix médian : ${sansPrix.map((l) => l.split("\n")[0]).join(", ")}`
  : `les ${lignesDep.length} départements affichent leur prix médian au m²`);
// et ce prix doit être celui du fichier de données, pas un chiffre recalculé
const coherent = await page.evaluate(async () => {
  const meta = await (await fetch("data/meta.json")).json();
  const affiches = [...document.querySelectorAll("#liste-communes details")].map((d) => ({
    dep: d.dataset.dep,
    prix: Number(d.querySelector(".stats-dep strong").textContent.replace(/[^\d]/g, "")),
  }));
  return affiches.filter((a) => meta.departements[a.dep]
    && meta.departements[a.dep].prix_m2_median !== a.prix);
});
verifier(coherent.length === 0, coherent.length
  ? `prix affiché ≠ donnée : ${JSON.stringify(coherent)}`
  : "chaque prix affiché correspond exactement à la donnée publiée");

const communesDansLesDonnees = await page.evaluate(async () => {
  const t = await (await fetch("data/communes.json")).json();
  return t.valeurs.length;
});
verifier(totalAnnonce === communesDansLesDonnees,
  `${totalAnnonce} communes annoncées, autant que dans les données`);

// dépliage d'un département
await page.click("#liste-communes details[data-dep=\"30\"] summary");
await page.waitForTimeout(200);
const communesGard = await page.locator('#liste-communes details[data-dep="30"] li').count();
verifier(communesGard > 300, `Gard déplié : ${communesGard} communes`);
await page.click("#liste-communes details[data-dep=\"30\"] summary");
await page.waitForTimeout(200);

// --- 2. la carte et le choroplèthe --------------------------------------
// Leaflet dessine les 692 communes sur un CANEVAS (option preferCanvas), pas en
// SVG : on verifie donc que le canevas est bien peint, et avec des couleurs
// variees -- c'est la preuve que le choroplethe fonctionne.
const peinture = await page.evaluate(() => {
  const c = document.querySelector("#carte canvas");
  if (!c) return null;
  const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
  let peints = 0; const couleurs = new Set();
  for (let i = 0; i < d.length; i += 4 * 97) {
    if (d[i + 3] > 10) { peints += 1; couleurs.add(`${d[i]},${d[i + 1]},${d[i + 2]}`); }
  }
  return { peints, couleurs: couleurs.size };
});
verifier(peinture && peinture.peints > 200 && peinture.couleurs > 20,
  `choroplèthe peint : ${peinture ? peinture.peints : 0} pixels, ${peinture ? peinture.couleurs : 0} couleurs distinctes`);
verifier(await page.locator(".legende").isVisible(), "légende des prix affichée");

// --- 3. la recherche sans accents ---------------------------------------
// La recherche fouille tous les départements d'un coup et déplie ce qu'il faut.
await page.fill("#champ-recherche", "nimes");
await page.waitForTimeout(250);
const trouves = await page.locator("#liste-communes li .nom").allInnerTexts();
verifier(trouves.some((t) => t === "Nîmes"),
  `recherche « nimes » trouve « Nîmes » parmi ${depsDansLesDonnees} départements`
  + ` (${trouves.length} résultat(s))`);

// --- 3 bis. les cas demandés, jusque dans le navigateur -------------------
// Les mêmes que tests/test_recherche.mjs, mais joués pour de vrai : ce qui est
// vérifié ici, c'est que le classement du module arrive intact jusqu'à l'écran.
for (const [saisie, attendu] of [["Pont Saint Esprit", "Pont-Saint-Esprit"],
                                 ["St Esprit", "Pont-Saint-Esprit"],
                                 ["ale", "Alès"],
                                 ["L'Isle sur la Sorgue", "L'Isle-sur-la-Sorgue"],
                                 ["30", "Nîmes"]]) {
  await page.fill("#champ-recherche", saisie);
  await page.waitForTimeout(200);
  const premier = await page.locator("#liste-communes li .nom").first().innerText()
    .catch(() => "(aucun résultat)");
  verifier(premier === attendu, `« ${saisie} » donne « ${premier} » en premier`
    + (premier === attendu ? "" : ` — attendu « ${attendu} »`));
}

// Le département doit être lisible sur chaque ligne : « La Garde » existe dans
// quatre départements, et rien d'autre ne permet de les distinguer.
await page.fill("#champ-recherche", "la garde");
await page.waitForTimeout(200);
const departementsAffiches = await page.locator("#liste-communes li .dep-resultat").allInnerTexts();
verifier(departementsAffiches.length > 0 && new Set(departementsAffiches).size > 1,
  `département affiché sur chaque résultat (${new Set(departementsAffiches).size} distincts)`);

// Le compteur ne doit pas annoncer un nombre qu'il n'affiche pas.
await page.fill("#champ-recherche", "a");
await page.waitForTimeout(300);
const compteurLarge = await page.locator("#compteur-communes").innerText();
const lignesAffichees = await page.locator("#liste-communes li").count();
verifier(!/^\d+ communes? trouvée/.test(compteurLarge) || lignesAffichees >= 3000,
  `compteur honnête sous le plafond : « ${compteurLarge} » pour ${lignesAffichees} lignes`);

await page.fill("#champ-recherche", "nimes");
await page.waitForTimeout(250);

// --- 4. sélection d'une commune -----------------------------------------
await page.click('#liste-communes li[data-code="30189"]');
await page.waitForSelector("#panneau-droit:not([hidden])", { timeout: 10000 });
const titre = await page.locator("#panneau-droit h2").innerText();
verifier(titre === "Nîmes", `panneau ouvert sur « ${titre} »`);
const stats = await page.locator(".stats-commune").isVisible();
verifier(stats, "statistiques de la commune affichées");

// les marqueurs de ventes doivent apparaître
await page.waitForTimeout(2500);
// Les ventes sont regroupees en "bulles" (markercluster) : ce sont de vraies
// icones dans le DOM, donc comptables. #carte canvas existe toujours et ne
// prouverait rien -- c'est le piege de la premiere version de ce test.
const bulles = await page.locator("#carte .leaflet-marker-icon").count();
verifier(bulles > 0, `ventes de Nîmes affichées sur la carte (${bulles} groupe(s) de points)`);
// et en zoomant a fond, les ventes doivent se separer en points individuels
await page.mouse.wheel(0, -600); await page.waitForTimeout(1500);
const apresZoom = await page.locator("#carte .leaflet-marker-icon").count();
verifier(apresZoom > 0, `après zoom : ${apresZoom} élément(s) de vente`);

// --- 4 bis. viser un point de vente au doigt ------------------------------
// Un point de vente ne faisait que 11 px de large, avec un capteur de clic
// grand comme toute la commune juste dessous : rater de 6 px suffisait a
// selectionner la ville, ce qui recentrait la carte ET effacait l'estimation
// en cours. Mesure avant correctif : bulle de 0 a 5 px, commune au-dela.
await page.evaluate(() => { window.__carte.setZoom(17); });
await page.waitForTimeout(1800);

// On repere une vente bien isolee, et on retient la vue pour pouvoir la
// remettre a l'identique entre deux essais -- sans cela, un essai qui recentre
// la carte fausse tous les suivants.
const venteVisee = await page.evaluate(() => {
  const boite = document.querySelector("#carte").getBoundingClientRect();
  const candidats = [];
  window.__carte.eachLayer((couche) => {
    if (couche instanceof L.CircleMarker && couche.getLatLng) {
      const p = window.__carte.latLngToContainerPoint(couche.getLatLng());
      if (p.x > 70 && p.x < boite.width - 70 && p.y > 70 && p.y < boite.height - 70) {
        candidats.push({ couche, p });
      }
    }
  });
  if (!candidats.length) return null;
  let choix = null, ecartMax = -1;
  for (const a of candidats) {
    let plusProche = Infinity;
    for (const b of candidats) {
      if (b !== a) plusProche = Math.min(plusProche, Math.hypot(a.p.x - b.p.x, a.p.y - b.p.y));
    }
    if (plusProche > ecartMax) { ecartMax = plusProche; choix = a; }
  }
  const position = choix.couche.getLatLng();
  const vue = window.__carte.getCenter();
  window.__vente = { lat: position.lat, lng: position.lng };
  window.__vue = { lat: vue.lat, lng: vue.lng, zoom: window.__carte.getZoom() };
  return { voisin: Math.round(ecartMax), candidats: candidats.length };
});

if (!venteVisee) {
  verifier(false, "aucun point de vente isolé à viser (le test ne prouve rien)");
} else {
  // Remet la vue, vide les compteurs, puis clique a "ecart" pixels du centre
  // du point. Les compteurs sont poses SUR les couches Leaflet : ils disent qui
  // recoit vraiment le clic, sans dependre d'un effet visible.
  const cliquerA = async (ecart) => {
    await page.evaluate(() => {
      window.__carte.closePopup();
      window.__carte.setView([window.__vue.lat, window.__vue.lng], window.__vue.zoom,
        { animate: false });
      window.__recu = { vente: 0, commune: 0 };
      if (!window.__compteursPoses) {
        window.__compteursPoses = true;
        window.__carte.eachLayer((couche) => {
          if (couche instanceof L.CircleMarker) couche.on("click", () => { window.__recu.vente += 1; });
          else if (couche instanceof L.Polygon) couche.on("click", () => { window.__recu.commune += 1; });
        });
      }
    });
    await page.waitForTimeout(400);
    const point = await page.evaluate(() => {
      const p = window.__carte.latLngToContainerPoint(
        L.latLng(window.__vente.lat, window.__vente.lng));
      const boite = document.querySelector("#carte").getBoundingClientRect();
      return { x: Math.round(p.x + boite.left), y: Math.round(p.y + boite.top) };
    });
    await page.mouse.click(point.x + ecart, point.y);
    await page.waitForTimeout(600);
    return page.evaluate(() => window.__recu);
  };

  verifier((await cliquerA(0)).vente > 0,
    "un clic sur un point de vente ouvre bien sa bulle");
  verifier((await cliquerA(15)).vente > 0,
    "un clic à 15 px du point ouvre encore sa bulle (cible tactile)");

  // Un clic franchement à côté, dans la commune déjà ouverte, ne doit RIEN
  // coûter : ni la position de la carte, ni l'estimation affichée.
  //
  // On produit donc une VRAIE estimation d'abord. Sans elle, ce contrôle
  // comparait « 0 caractère » à « 0 caractère » et passait sans rien prouver --
  // il l'a fait, et c'est ce qui a conduit à ajouter ces trois lignes.
  await page.fill("#surface-habitable", "135");
  await page.click("#formulaire-estimation button[type=\"submit\"]");
  await page.waitForTimeout(2000);
  const estimationPosee = await page.evaluate(() => {
    const zone = document.querySelector("#resultat-estimation");
    return zone ? zone.innerText.trim().length : 0;
  });
  verifier(estimationPosee > 20,
    `une estimation est bien affichée avant le clic manqué (${estimationPosee} caractères)`);

  await page.evaluate(() => {
    window.__carte.closePopup();
    window.__carte.setView([window.__vue.lat, window.__vue.lng], window.__vue.zoom,
      { animate: false });
    // on se décale, pour qu'un recentrage sur la commune se voie
    const p = window.__carte.latLngToContainerPoint(window.__carte.getCenter());
    window.__carte.setView(
      window.__carte.containerPointToLatLng(L.point(p.x + 120, p.y + 80)),
      window.__vue.zoom, { animate: false });
  });
  await page.waitForTimeout(500);
  const avantClicPerdu = await page.evaluate(() => {
    const c = window.__carte.getCenter();
    const zone = document.querySelector("#resultat-estimation");
    return { vue: c.lat.toFixed(6) + "," + c.lng.toFixed(6),
             estimation: zone ? zone.innerText.trim().length : 0 };
  });
  const loin = await page.evaluate(() => {
    const p = window.__carte.latLngToContainerPoint(
      L.latLng(window.__vente.lat, window.__vente.lng));
    const boite = document.querySelector("#carte").getBoundingClientRect();
    return { x: Math.round(p.x + boite.left) + 70, y: Math.round(p.y + boite.top) + 50 };
  });
  await page.mouse.click(loin.x, loin.y);
  await page.waitForTimeout(1200);
  const apresClicPerdu = await page.evaluate(() => {
    const c = window.__carte.getCenter();
    const zone = document.querySelector("#resultat-estimation");
    return { vue: c.lat.toFixed(6) + "," + c.lng.toFixed(6),
             estimation: zone ? zone.innerText.trim().length : 0 };
  });
  verifier(avantClicPerdu.vue === apresClicPerdu.vue,
    `un clic manqué ne déplace pas la carte (${avantClicPerdu.vue} → ${apresClicPerdu.vue})`);
  verifier(avantClicPerdu.estimation === apresClicPerdu.estimation,
    `un clic manqué n'efface pas l'estimation affichée`
    + ` (${avantClicPerdu.estimation} → ${apresClicPerdu.estimation} caractères)`);

  // Non-régression indispensable : changer de commune doit toujours marcher.
  await page.fill("#champ-recherche", "uzes");
  await page.waitForTimeout(300);
  await page.click("#liste-communes li[data-code=\"30334\"]");
  await page.waitForTimeout(1500);
  const titreApres = await page.locator("#panneau-droit h2").innerText();
  verifier(titreApres === "Uzès",
    `choisir une AUTRE commune fonctionne toujours (« ${titreApres} »)`);
  await page.fill("#champ-recherche", "nimes");
  await page.waitForTimeout(300);
  await page.click("#liste-communes li[data-code=\"30189\"]");
  await page.waitForTimeout(1500);
}

verifier(await page.locator("#avertissement-fond").isVisible(),
  "avertissement « fond de carte indisponible » affiché ET conservé");
await page.screenshot({ path: SP + "/apercu-1-carte.png" });

// --- 5. estimation --------------------------------------------------------
await page.fill("#surface-habitable", "120");
await page.fill("#surface-terrain", "600");
await page.fill("#nombre-pieces", "5");
await page.click(".bouton-principal");
await page.waitForSelector(".resultat", { timeout: 15000 });

const valeur = await page.locator(".valeur-principale").innerText();
verifier(/\d/.test(valeur), `estimation produite : ${valeur}`);
const fourchette = await page.locator(".fourchette").innerText();
verifier(fourchette.includes("–"), `fourchette : ${fourchette}`);
const confiance = await page.locator(".confiance").innerText();
verifier(/Fiabilité/.test(confiance), `fiabilité : ${confiance.split("—")[0].trim()}`);
const nbComparables = await page.locator(".comparables tbody tr").count();
verifier(nbComparables > 0 && nbComparables <= 10, `${nbComparables} ventes comparables listées`);

await page.screenshot({ path: SP + "/apercu-2-estimation.png" });

// --- 6. cas limite : commune sans assez de ventes -------------------------
const codeVide = await page.evaluate(async () => {
  const r = await fetch("data/communes.json"); const t = await r.json();
  const ligne = t.valeurs.find((l) => l[5] < 5 && l[5] >= 0);
  return ligne ? ligne[0] : null;
});
if (codeVide) {
  // on la retrouve par son code : la recherche accepte aussi les codes INSEE
  await page.fill("#champ-recherche", codeVide);
  await page.waitForTimeout(300);
  await page.evaluate((code) => {
    document.querySelector(`#liste-communes li[data-code="${code}"]`).click();
  }, codeVide);
  await page.waitForTimeout(600);
  await page.fill("#surface-habitable", "110");
  await page.click(".bouton-principal");
  await page.waitForTimeout(2500);
  const texte = await page.locator("#resultat-estimation").innerText();
  // Deux reponses honnetes possibles : soit on refuse, soit on annonce
  // clairement que l'on s'est appuye sur les communes voisines ET on n'affiche
  // pas une fiabilite flatteuse.
  const refus = /Pas assez de ventes/.test(texte);
  const elargissementAnnonce = /communes limitrophes|département par tranche/.test(texte);
  const fiabiliteProuvee = /Fiabilité\s*:\s*Faible/.test(texte);
  const honnete = refus || (elargissementAnnonce && fiabiliteProuvee);
  verifier(honnete, `commune ${codeVide} (peu de ventes) : ${refus ? "refus de chiffrer"
    : "élargissement annoncé + fiabilité faible"}`);
  if (!honnete) console.log(texte.slice(0, 400));
  await page.screenshot({ path: SP + "/apercu-3-donnees-faibles.png" });
} else {
  verifier(true, "aucune commune à faible volume dans ce jeu (test ignoré)");
}

// --- 6 bis. non-regression : deplacer la carte ne doit rien casser ---------
await page.fill("#champ-recherche", "nimes");
await page.waitForTimeout(300);
await page.evaluate(() => document.querySelector('#liste-communes li[data-code="30189"]').click());
await page.waitForTimeout(800);
await page.fill("#surface-habitable", "135");
// On vide d'abord la recherche (sinon le Gard ne contient qu'une ligne), puis
// on déplie un département : sans cela la liste est trop courte pour défiler et
// le test passerait sans rien prouver.
//
// Le dépliage est demandé EXPLICITEMENT, et non par un clic qui bascule. La
// version précédente cliquait sur le titre en supposant qu'il était replié —
// ce qui n'était vrai que par un défaut aujourd'hui corrigé : une recherche
// marquait au passage tous les départements affichés comme « ouverts par
// l'utilisateur », si bien qu'après l'avoir effacée on retrouvait les
// quatorze groupes dépliés sans en avoir ouvert un seul.
await page.fill("#champ-recherche", "");
await page.waitForTimeout(250);
const gardReplie = await page.evaluate(() =>
  !document.querySelector('#liste-communes details[data-dep="30"]').open);
if (gardReplie) await page.click('#liste-communes details[data-dep="30"] summary');
await page.waitForTimeout(250);
verifier(await page.evaluate(() =>
  document.querySelector('#liste-communes details[data-dep="30"]').open),
  "le Gard est déplié avant de mesurer le défilement");
const defilementAvant = await page.evaluate(() => {
  const l = document.querySelector("#liste-communes"); l.scrollTop = 400; return l.scrollTop;
});
verifier(defilementAvant > 0, `liste défilable après dépliage (${defilementAvant} px)`);
await page.mouse.move(700, 500);
await page.mouse.down(); await page.mouse.move(600, 460, { steps: 8 }); await page.mouse.up();
await page.waitForTimeout(1200);
const apresDeplacement = await page.evaluate(() => ({
  valeur: document.querySelector("#surface-habitable").value,
  focus: document.activeElement && document.activeElement.id,
  defilement: document.querySelector("#liste-communes").scrollTop,
}));
verifier(apresDeplacement.valeur === "135",
  `saisie conservée après déplacement de la carte (« ${apresDeplacement.valeur} »)`);
// Note : faire GLISSER la carte donne legitimement le focus a la carte. Ce qui
// compte est que le panneau n'ait pas ete reconstruit -- donc que la saisie et
// le defilement survivent.
verifier(apresDeplacement.defilement === defilementAvant,
  `position de la liste conservée (${apresDeplacement.defilement} / ${defilementAvant})`);

// --- 6 ter. les icônes et le manifeste ------------------------------------
// On demande au NAVIGATEUR de résoudre lui-même chaque chemin relatif, puis de
// le télécharger. C'est la seule façon de prouver qu'ils fonctionneront depuis
// le sous-dossier de production.
const icones = await page.evaluate(async () => {
  const liens = [...document.querySelectorAll('link[rel*="icon"], link[rel="manifest"]')];
  const resultats = [];
  for (const lien of liens) {
    let statut = 0;
    try { statut = (await fetch(lien.href, { cache: "no-store" })).status; } catch (e) { statut = -1; }
    resultats.push({
      rel: lien.getAttribute("rel"),
      declare: lien.getAttribute("href"),
      resolu: lien.href,
      statut,
    });
  }
  return resultats;
});
verifier(icones.length >= 5, `${icones.length} icônes/manifeste déclarés dans la page`);
const cassees = icones.filter((i) => i.statut !== 200);
verifier(cassees.length === 0, cassees.length
  ? "chemins cassés : " + cassees.map((i) => `${i.declare} → ${i.statut}`).join(", ")
  : "toutes les icônes se chargent (chemins résolus par le navigateur)");
const absolus = icones.filter((i) => i.declare.startsWith("/") || i.declare.startsWith("http"));
verifier(absolus.length === 0, absolus.length
  ? "chemins absolus : " + absolus.map((i) => i.declare).join(", ")
  : "aucun chemin absolu (indispensable en sous-dossier)");
verifier(icones.every((i) => i.resolu.includes(BASE === "/" ? "/" : BASE)),
  `résolus sous ${BASE} (ex. ${icones[0].resolu.replace(/^https?:\/\/[^/]+/, "")})`);

// le SVG doit réellement se rastériser, pas seulement répondre 200
const svgOk = await page.evaluate(() => new Promise((resoudre) => {
  const lien = document.querySelector('link[type="image/svg+xml"]');
  if (!lien) return resoudre("aucun favicon SVG déclaré");
  const img = new Image();
  img.onload = () => resoudre(img.naturalWidth > 0 ? null : "SVG de largeur nulle");
  img.onerror = () => resoudre("le SVG ne se rastérise pas");
  img.src = lien.href;
}));
verifier(svgOk === null, svgOk || "le favicon SVG se rastérise correctement");

// le manifeste : parsable, et son start_url tombe bien sur le site
const manifeste = await page.evaluate(async () => {
  const lien = document.querySelector('link[rel="manifest"]');
  const m = await (await fetch(lien.href, { cache: "no-store" })).json();
  return { ...m, urlDemarrage: new URL(m.start_url, lien.href).pathname };
});
verifier(manifeste.short_name === "Ventes DVF",
  `étiquette de l'écran d'accueil : « ${manifeste.short_name} »`);
verifier(manifeste.urlDemarrage === BASE,
  `start_url résolu → ${manifeste.urlDemarrage} (attendu ${BASE})`);
verifier(manifeste.icons.length >= 3 && manifeste.icons.some((i) => /maskable/.test(i.purpose || "")),
  `${manifeste.icons.length} icônes dans le manifeste, dont une « maskable »`);

// --- 6 quater. la recherche ne peut pas injecter de code -------------------
const ATTAQUE = '<img src=x onerror="document.title=\'XSS\'">';
const titreAvant = await page.title();
await page.fill("#champ-recherche", ATTAQUE);
await page.waitForTimeout(500);
const imagesInjectees = await page.locator("#liste-communes img").count();
verifier(imagesInjectees === 0,
  `aucune balise injectée par la recherche (${imagesInjectees} trouvée(s))`);
verifier((await page.title()) === titreAvant,
  `le titre de la page est intact (« ${await page.title()} »)`);
// et le texte tapé doit rester VISIBLE : on échappe, on ne supprime pas
const texteVide = await page.locator("#liste-communes .vide").innerText().catch(() => "");
verifier(texteVide.includes("<img"),
  `la saisie est réaffichée telle quelle à l'utilisateur : ${texteVide.slice(0, 60)}…`);
await page.fill("#champ-recherche", "");
await page.waitForTimeout(300);

// --- 6 quinquies. la politique de sécurité ne casse rien ------------------
const violations = await page.evaluate(() => window.__violationsCsp || []);
const bloquantes = violations.filter((v) => !/^img-src/.test(v));  // les tuiles sont hors ligne ici
verifier(bloquantes.length === 0, bloquantes.length
  ? `la CSP bloque des ressources nécessaires : ${bloquantes.join(", ")}`
  : `aucune ressource nécessaire bloquée par la politique de sécurité`);

// --- 6 sexies. LA COURSE : estimation de A affichée sous le titre de B -----
// On ralentit artificiellement le fichier de ventes de Nîmes de 2,5 s, puis on
// clique Uzès pendant ce temps. Sans garde-fou, les chiffres de Nîmes
// arrivent en dernier et s'affichent sous le titre « Uzès ».
// Rechargement préalable : la page garde les ventes en cache, et un fichier
// déjà chargé ne serait pas retéléchargé, donc pas ralenti.
await page.reload({ waitUntil: "networkidle" });
await page.waitForSelector("#application:not([hidden])");
await page.waitForTimeout(800);

async function estimer(codeCommune, nomRecherche, surface) {
  await page.fill("#champ-recherche", nomRecherche);
  await page.waitForTimeout(300);
  await page.evaluate((c) => document.querySelector(`#liste-communes li[data-code="${c}"]`).click(),
    codeCommune);
  await page.waitForTimeout(400);
  await page.fill("#surface-habitable", String(surface));
  await page.click(".bouton-principal");
}

// (a) référence : une estimation à 120 m² sur Nîmes, sans ralentissement
await estimer("30189", "nimes", 120);
await page.waitForSelector(".valeur-principale", { timeout: 15000 });
const valeur120 = await page.locator(".valeur-principale").innerText();

// (b) la course proprement dite
await page.reload({ waitUntil: "networkidle" });
await page.waitForSelector("#application:not([hidden])");
await page.waitForTimeout(800);
await page.route("**/data/ventes/30/30189.json", async (route) => {
  await new Promise((r) => setTimeout(r, 2500));
  await route.continue();
});

await estimer("30189", "nimes", 120);          // Nîmes : lent
await page.waitForTimeout(300);
await page.fill("#champ-recherche", "uzes");   // on part sur Uzès sans attendre
await page.waitForTimeout(300);
await page.evaluate(() => document.querySelector('#liste-communes li[data-code="30334"]').click());
await page.waitForTimeout(4500);               // Nîmes a largement fini entre-temps

const titreAffiche = (await page.locator("#panneau-droit h2").innerText()).trim();
const valeursAffichees = await page.locator(".valeur-principale").count();
const enCours = await page.locator("#resultat-estimation .chargement").count();
verifier(titreAffiche === "Uzès", `le panneau affiche « ${titreAffiche} »`);
verifier(valeursAffichees === 0,
  valeursAffichees === 0
    ? "aucun montant de Nîmes ne s'affiche sous le titre d'Uzès"
    : `ATTENTION : ${valeursAffichees} montant affiché sous « ${titreAffiche} » — `
      + `« ${await page.locator(".valeur-principale").first().innerText()} »`);
verifier(enCours === 0, "aucun indicateur de chargement resté bloqué");

// (c) fermer le panneau pendant une estimation — on exerce le chemin, SANS
// prétendre le vérifier. Deux cas ont été retirés d'ici parce qu'ils passaient
// avec ET sans correctif, donc ne prouvaient rien :
//   - « deux estimations sur la même commune » : les deux requêtes attendent le
//     même fichier, donc le même cache ; elles se résolvent forcément dans
//     l'ordre. Couvert au niveau logique dans tests/test_demandes.mjs.
//   - « l'indicateur reste bloqué après fermeture » : rouvrir la commune passe
//     par selectionnerCommune, qui remet déjà l'indicateur à zéro. Le correctif
//     de fermer() reste juste — il évite d'enregistrer un résultat arrivé après
//     la fermeture — mais je n'ai pas su construire de scénario où le défaut
//     est observable depuis l'interface.
// Ce qui suit reste utile : si ce chemin levait une exception, le contrôle
// « aucune erreur JavaScript » en fin de fichier la signalerait.
await estimer("30189", "nimes", 120);
await page.waitForTimeout(400);
await page.click("#fermer-panneau");
await page.waitForTimeout(3500);
await page.unroute("**/data/ventes/30/30189.json");

// --- 6 septies. une panne réseau ne devient pas « aucune vente » -----------
await page.reload({ waitUntil: "networkidle" });
await page.waitForSelector("#application:not([hidden])");
await page.waitForTimeout(800);
await page.route("**/data/ventes/30/30189.json", (route) => route.abort("failed"));
await estimer("30189", "nimes", 120);
await page.waitForTimeout(3000);
const texteResultat = await page.locator("#resultat-estimation").innerText();
verifier(/n'ont pas pu être téléchargées/.test(texteResultat),
  "une panne réseau affiche un message clair, pas une estimation dégradée");
verifier((await page.locator(".valeur-principale").count()) === 0,
  "aucun montant calculé sur les communes voisines en cas de panne");
await page.unroute("**/data/ventes/30/30189.json");

// --- 7. aucune erreur JavaScript -----------------------------------------
const vraiesErreurs = erreurs.filter((e) => !/tile|ERR_|net::|Failed to load resource/i.test(e));
verifier(vraiesErreurs.length === 0,
  vraiesErreurs.length ? "erreurs JS : " + vraiesErreurs.join(" | ") : "aucune erreur JavaScript");

await navigateur.close();
console.log(echecs === 0 ? "\nTOUT EST CONFORME" : `\n${echecs} VERIFICATION(S) EN ECHEC`);
process.exit(echecs === 0 ? 0 : 1);
