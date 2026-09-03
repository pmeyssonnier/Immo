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
// La recherche fouille les 8 départements d'un coup et déplie ce qu'il faut.
await page.fill("#champ-recherche", "nimes");
await page.waitForTimeout(250);
const trouves = await page.locator("#liste-communes li .nom").allInnerTexts();
verifier(trouves.some((t) => t === "Nîmes"),
  `recherche « nimes » trouve « Nîmes » parmi ${depsDansLesDonnees} départements`
  + ` (${trouves.length} résultat(s))`);

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
await page.fill("#champ-recherche", "");
await page.waitForTimeout(250);
await page.click('#liste-communes details[data-dep="30"] summary');
await page.waitForTimeout(250);
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

// --- 7. aucune erreur JavaScript -----------------------------------------
const vraiesErreurs = erreurs.filter((e) => !/tile|ERR_|net::|Failed to load resource/i.test(e));
verifier(vraiesErreurs.length === 0,
  vraiesErreurs.length ? "erreurs JS : " + vraiesErreurs.join(" | ") : "aucune erreur JavaScript");

await navigateur.close();
console.log(echecs === 0 ? "\nTOUT EST CONFORME" : `\n${echecs} VERIFICATION(S) EN ECHEC`);
process.exit(echecs === 0 ? 0 : 1);
