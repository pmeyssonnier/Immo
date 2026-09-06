// Backtest historique de l'estimateur.
//
// LA QUESTION : quelle est l'erreur reelle du moteur sur des ventes qu'il n'a
// jamais vues ? Les 98 tests JavaScript prouvent qu'il calcule COMME IL A ETE
// CONCU ; aucun ne prouve que ses estimations sont JUSTES. Tant que ce chiffre
// n'existe pas, le mot « Fiabilite » affiche a l'ecran ne mesure que la quantite
// de comparables, et la fourchette annoncee n'a jamais ete confrontee au reel.
//
// LE PIEGE : un backtest naif donne d'excellents resultats FAUX. Quatre entrees
// du moteur connaissent l'avenir si on n'y prend pas garde :
//
//   1. tReference        -- l'application estime « a aujourd'hui » ; ici on
//                           estime A LA DATE DE LA VENTE.
//   2. indicesAnnuels    -- calcule sur toutes les annees et normalise sur la
//                           derniere ; recalcule ici pour chaque annee testee.
//   3. bandes            -- statistiques departementales, meme probleme.
//   4. prix_terrain      -- mediane sur tout l'historique ; l'ajustement terrain
//                           est donc DESACTIVE, ce qui est le comportement par
//                           defaut de l'application et supprime la fuite au lieu
//                           de la contourner.
//
// Et l'evidence : la vente testee, et toutes les ventes posterieures, sont
// retirees de ses propres comparables.
//
// DECOUPE : par annee. Une vente de 2024 n'est estimee qu'avec 2021-2023. C'est
// plus SEVERE que la realite -- l'application, un jour de 2024, disposerait aussi
// des ventes de janvier a aout 2024. Le chiffre obtenu est donc legerement
// pessimiste, et c'est dit plutot que tu.
//
// LE MOTEUR EST LE VRAI. On importe js/estimation.js, on ne le reecrit pas :
// mesurer une copie ne mesurerait pas le produit.
//
// Usage :
//   node scripts/backtester.mjs [--echantillon 20000] [--graine 1] [--avec-fuite]
//
// --avec-fuite sert a la VERIFICATION, mais pas comme je le croyais. J'attendais
// que les fuites ameliorent nettement les chiffres. Mesure faite : 20,2 % sans
// fuite, 18,2 % avec -- deux points. Et c'est NORMAL : l'estimation est une
// mediane ponderee sur des centaines de comparables, qu'une vente de plus, meme
// au poids maximal, ne peut pas deplacer.
//
// La verification du garde-fou temporel est donc STRUCTURELLE et vit dans
// tests/test_backtest.mjs : un espion inspecte les comparables reellement remis
// au moteur et exige qu'aucun ne vienne de l'annee testee ni des suivantes.
// Deduire l'absence de fuite d'une statistique aurait ete un test qui passe pour
// une mauvaise raison.

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { estimer, estimerParBandes } from "../js/estimation.js";

const RACINE = join(dirname(fileURLToPath(import.meta.url)), "..");
const lire = (chemin) => JSON.parse(readFileSync(join(RACINE, chemin), "utf8"));

// Bandes de surface : doivent rester d'accord avec BANDES_SURFACE du robot.
// Un controle le verifie contre les fichiers publies.
const BANDES_SURFACE = [[0, 70], [70, 90], [90, 110], [110, 130],
                        [130, 160], [160, 200], [200, 601]];

// --------------------------------------------------------------------------
// Les memes calculs que le robot, transposes. Un controle verifie qu'ils
// reproduisent EXACTEMENT ce qu'il publie quand on leur donne toutes les annees.
// --------------------------------------------------------------------------

export function quantile(triees, q) {
  if (!triees.length) return null;
  const position = q * (triees.length - 1);
  const bas = Math.floor(position);
  const haut = Math.min(bas + 1, triees.length - 1);
  const poids = position - bas;
  return triees[bas] * (1 - poids) + triees[haut] * poids;
}

const mediane = (valeurs) => quantile([...valeurs].sort((a, b) => a - b), 0.5);

/** Indice de prix annuel par departement, normalise sur la derniere annee. */
export function calculerIndice(ventes, anneeOrigine) {
  const parDepAnnee = new Map();
  for (const v of ventes) {
    const cle = v.dep + "|" + (anneeOrigine + Math.floor(v.t / 12));
    if (!parDepAnnee.has(cle)) parDepAnnee.set(cle, []);
    parDepAnnee.get(cle).push(v.prix / v.sbati);
  }
  const indice = {};
  for (const [cle, valeurs] of parDepAnnee) {
    if (valeurs.length < 20) continue;          // meme seuil que le robot
    const [dep, annee] = cle.split("|");
    (indice[dep] ??= {})[annee] = mediane(valeurs);
  }
  for (const dep of Object.keys(indice)) {
    const annees = Object.keys(indice[dep]);
    const reference = indice[dep][String(Math.max(...annees.map(Number)))];
    for (const a of annees) {
      indice[dep][a] = Math.round((indice[dep][a] / reference) * 1e4) / 1e4;
    }
  }
  return indice;
}

/** Table de repli par bande de surface, pour UN departement. */
export function calculerBandes(ventes) {
  const valeurs = [];
  for (const [inf, sup] of BANDES_SURFACE) {
    const prixM2 = ventes
      .filter((v) => v.sbati >= inf && v.sbati < sup)
      .map((v) => v.prix / v.sbati)
      .sort((a, b) => a - b);
    if (prixM2.length < 5) continue;
    valeurs.push([inf, sup, prixM2.length,
                  Math.round(quantile(prixM2, 0.25)),
                  Math.round(quantile(prixM2, 0.5)),
                  Math.round(quantile(prixM2, 0.75))]);
  }
  return { champs: ["borne_inf", "borne_sup", "n", "m2_q1", "m2_med", "m2_q3"],
           valeurs };
}

// --------------------------------------------------------------------------
// Chargement
// --------------------------------------------------------------------------

export function chargerTout() {
  const meta = lire("data/meta.json");
  const table = lire("data/communes.json");
  const iC = (nom) => table.champs.indexOf(nom);
  const communes = new Map(table.valeurs.map((l) => [l[iC("code")], {
    code: l[iC("code")], nom: l[iC("nom")], dep: l[iC("dep")],
    n: l[iC("n")], prixTerrain: l[iC("prix_terrain")],
  }]));

  const parCommune = new Map();
  const dossier = join(RACINE, "data/ventes");
  for (const dep of readdirSync(dossier)) {
    for (const fichier of readdirSync(join(dossier, dep))) {
      const t = lire(`data/ventes/${dep}/${fichier}`);
      const idx = Object.fromEntries(t.champs.map((nom, i) => [nom, i]));
      const ventes = t.ventes.map((l) => ({
        t: l[idx.t], prix: l[idx.prix], sbati: l[idx.sbati],
        sterr: l[idx.sterr], pieces: l[idx.pieces], dep, code: t.code,
      }));
      parCommune.set(t.code, ventes);
    }
  }
  return { meta, communes, parCommune, adjacence: lire("data/adjacence.json") };
}

// --------------------------------------------------------------------------
// Tirage reproductible
// --------------------------------------------------------------------------

/** Generateur simple et deterministe : deux executions donnent le meme tirage. */
function alea(graine) {
  let etat = graine >>> 0;
  return () => {
    etat = (etat * 1664525 + 1013904223) >>> 0;
    return etat / 4294967296;
  };
}

// --------------------------------------------------------------------------
// Le backtest lui-meme
// --------------------------------------------------------------------------

export function backtester({ monde, taille = 20000, graine = 1, avecFuite = false,
                             espion = null }) {
  const { meta, communes, parCommune, adjacence } = monde;
  const origine = meta.annee_origine;
  const anneeDe = (t) => origine + Math.floor(t / 12);

  const toutes = [];
  for (const ventes of parCommune.values()) toutes.push(...ventes);

  const anneesPresentes = [...new Set(toutes.map((v) => anneeDe(v.t)))].sort();
  // Il faut au moins deux annees d'anteriorite pour que le passe veuille dire
  // quelque chose : la premiere annee testable est donc la troisieme.
  const anneesTestables = anneesPresentes.slice(2);

  // --- le passe, une fois par annee testee (et non par vente) --------------
  const passeParAnnee = new Map();
  for (const annee of anneesTestables) {
    const passe = avecFuite ? toutes : toutes.filter((v) => anneeDe(v.t) < annee);
    const bandesParDep = new Map();
    const parDep = new Map();
    for (const v of passe) {
      if (!parDep.has(v.dep)) parDep.set(v.dep, []);
      parDep.get(v.dep).push(v);
    }
    for (const [dep, ventes] of parDep) bandesParDep.set(dep, calculerBandes(ventes));
    passeParAnnee.set(annee, {
      indice: calculerIndice(passe, origine),
      bandesParDep,
      parCommune: (() => {
        const m = new Map();
        for (const v of passe) {
          if (!m.has(v.code)) m.set(v.code, []);
          m.get(v.code).push(v);
        }
        return m;
      })(),
    });
  }

  // --- l'echantillon ------------------------------------------------------
  const candidates = toutes.filter((v) => anneesTestables.includes(anneeDe(v.t))
    && v.prix > 0 && v.sbati > 0);
  const tirage = alea(graine);
  const melangees = candidates.map((v) => [tirage(), v])
    .sort((a, b) => a[0] - b[0]).map((x) => x[1]);
  const echantillon = melangees.slice(0, Math.min(taille, melangees.length));

  // --- on rejoue les trois paliers de js/app.js ---------------------------
  const resultats = [];
  for (const vente of echantillon) {
    const annee = anneeDe(vente.t);
    const passe = passeParAnnee.get(annee);
    const commune = communes.get(vente.code);
    if (!commune) continue;

    const commun = {
      surface: vente.sbati,
      terrain: vente.sterr,
      pieces: vente.pieces,
      ajusterTerrain: false,          // supprime la fuite du prix du terrain
      prixTerrain: null,
      tReference: vente.t,            // on estime A LA DATE DE LA VENTE
      anneeOrigine: origine,
      indicesAnnuels: passe.indice[commune.dep] || {},
    };

    // En mode fuite, la vente testee reste dans ses propres comparables : c'est
    // LA fuite maximale, celle qui doit faire s'effondrer l'erreur. Sans ca, le
    // controle ne testait que « voir l'avenir » -- et l'avenir, sur trois ans,
    // ne change presque rien.
    const garder = (v) => avecFuite || v !== vente;
    const propres = (passe.parCommune.get(vente.code) || [])
      .filter(garder)
      .map((v) => ({ ...v, voisine: false }));
    // L'espion sert aux tests : il permet de VERIFIER quelles ventes ont ete
    // remises au moteur, plutot que de le deduire d'une statistique.
    if (espion) espion({ vente, comparables: propres, tReference: commun.tReference });
    let resultat = estimer({ ...commun, ventes: propres, palier: 0 });

    if (!resultat.suffisant) {
      const voisines = adjacence[vente.code] || [];
      if (voisines.length) {
        const ventesVoisines = voisines.flatMap(
          (autre) => (passe.parCommune.get(autre) || [])
            .filter(garder)
            .map((v) => ({ ...v, voisine: true })));
        const elargi = estimer({
          ...commun, ventes: propres.concat(ventesVoisines), palier: 1,
        });
        if (elargi.nEffectif > resultat.nEffectif) resultat = elargi;
      }
    }

    if (resultat.valeur === null) {
      const bandes = passe.bandesParDep.get(commune.dep);
      if (bandes) {
        const repli = estimerParBandes({ bandes, surface: vente.sbati });
        if (repli.valeur !== null) resultat = repli;
      }
    }

    resultats.push({
      code: vente.code, dep: commune.dep, annee,
      surface: vente.sbati, reel: vente.prix,
      estime: resultat.valeur,
      confiance: resultat.confiance,
      palier: resultat.palier,
      basse: resultat.fourchette ? resultat.fourchette[0] : null,
      haute: resultat.fourchette ? resultat.fourchette[1] : null,
    });
  }
  return resultats;
}

// --------------------------------------------------------------------------
// Agregation
// --------------------------------------------------------------------------

function mesures(lignes) {
  const chiffrees = lignes.filter((l) => l.estime !== null && l.reel > 0);
  if (!chiffrees.length) return { n: lignes.length, chiffrees: 0 };
  const ecarts = chiffrees.map((l) => (l.estime - l.reel) / l.reel);
  const absolus = ecarts.map(Math.abs).sort((a, b) => a - b);
  const dans = (seuil) => 100 * ecarts.filter((e) => Math.abs(e) <= seuil).length / ecarts.length;
  const avecFourchette = chiffrees.filter((l) => l.basse !== null);
  return {
    n: lignes.length,
    chiffrees: chiffrees.length,
    refus: 100 * (lignes.length - chiffrees.length) / lignes.length,
    erreurMediane: 100 * quantile(absolus, 0.5),
    mape: 100 * absolus.reduce((a, b) => a + b, 0) / absolus.length,
    mae: chiffrees.reduce((a, l) => a + Math.abs(l.estime - l.reel), 0) / chiffrees.length,
    biaisMoyen: 100 * ecarts.reduce((a, b) => a + b, 0) / ecarts.length,
    biaisMedian: 100 * quantile([...ecarts].sort((a, b) => a - b), 0.5),
    dans5: dans(0.05), dans10: dans(0.10), dans15: dans(0.15),
    couverture: avecFourchette.length
      ? 100 * avecFourchette.filter((l) => l.reel >= l.basse && l.reel <= l.haute).length
        / avecFourchette.length
      : null,
  };
}

function grouper(lignes, cle) {
  const groupes = new Map();
  for (const l of lignes) {
    const k = String(cle(l));
    if (!groupes.has(k)) groupes.set(k, []);
    groupes.get(k).push(l);
  }
  return Object.fromEntries([...groupes.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, v]) => [k, mesures(v)]));
}

function nombre(x, dec = 1) {
  return x === null || x === undefined ? "—" : x.toFixed(dec);
}

function rapport(lignes, options) {
  const g = mesures(lignes);
  const L = [];
  L.push("Backtest de l'estimateur — " + new Date().toISOString().slice(0, 16).replace("T", " "));
  L.push("=".repeat(66));
  L.push("");
  L.push(`Ventes testées : ${g.n}   (estimation produite dans ${g.chiffrees} cas)`);
  L.push(`Refus d'estimer : ${nombre(g.refus)} %  — le moteur préfère se taire`);
  L.push(`Découpe : par année, sans aucune vente de l'année testée ni des suivantes`);
  if (options.avecFuite) L.push("!! EXÉCUTION AVEC FUITE VOLONTAIRE — chiffres non valides !!");
  L.push("");
  L.push("ERREUR");
  L.push(`  erreur absolue médiane : ${nombre(g.erreurMediane)} %`);
  L.push(`  MAPE                   : ${nombre(g.mape)} %`);
  L.push(`  MAE                    : ${Math.round(g.mae).toLocaleString("fr-FR")} €`);
  L.push(`  biais moyen / médian   : ${nombre(g.biaisMoyen)} % / ${nombre(g.biaisMedian)} %`);
  L.push("");
  L.push("PRÉCISION");
  L.push(`  dans ±5 %  : ${nombre(g.dans5)} %`);
  L.push(`  dans ±10 % : ${nombre(g.dans10)} %`);
  L.push(`  dans ±15 % : ${nombre(g.dans15)} %`);
  L.push("");
  L.push(`COUVERTURE DE LA FOURCHETTE AFFICHÉE : ${nombre(g.couverture)} %`);
  L.push("  (le vrai prix tombe-t-il dans la fourchette montrée à l'utilisateur ?)");
  L.push("");
  for (const [titre, cle] of [["PAR FIABILITÉ ANNONCÉE", (l) => l.confiance],
                              ["PAR PALIER (0 commune, 1 voisines, 2 bandes)", (l) => l.palier],
                              ["PAR ANNÉE", (l) => l.annee],
                              ["PAR DÉPARTEMENT", (l) => l.dep]]) {
    L.push(titre);
    L.push("  " + "clé".padEnd(16) + "n".padStart(7) + "err.méd.".padStart(11)
           + "±10 %".padStart(9) + "couverture".padStart(12));
    for (const [k, m] of Object.entries(grouper(lignes, cle))) {
      L.push("  " + k.padEnd(16) + String(m.n).padStart(7)
             + (nombre(m.erreurMediane) + " %").padStart(11)
             + (nombre(m.dans10) + " %").padStart(9)
             + (nombre(m.couverture) + " %").padStart(12));
    }
    L.push("");
  }
  return L.join("\n");
}

// --------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  const valeur = (nom, defaut) => {
    const i = args.indexOf(nom);
    return i >= 0 && args[i + 1] ? Number(args[i + 1]) : defaut;
  };
  const options = {
    taille: valeur("--echantillon", 20000),
    graine: valeur("--graine", 1),
    avecFuite: args.includes("--avec-fuite"),
  };

  process.stdout.write("Chargement des ventes... ");
  const monde = chargerTout();
  let total = 0;
  for (const v of monde.parCommune.values()) total += v.length;
  console.log(`${total.toLocaleString("fr-FR")} ventes, ${monde.communes.size} communes`);

  const debut = Date.now();
  const lignes = backtester({ monde, ...options });
  console.log(`${lignes.length} estimations en ${((Date.now() - debut) / 1000).toFixed(1)} s\n`);

  const texte = rapport(lignes, options);
  console.log(texte);

  const dossier = join(RACINE, "audit/backtest");
  mkdirSync(dossier, { recursive: true });
  const suffixe = options.avecFuite ? "-avec-fuite" : "";
  writeFileSync(join(dossier, `rapport${suffixe}.txt`), texte + "\n");
  writeFileSync(join(dossier, `resume${suffixe}.json`), JSON.stringify({
    genere_le: new Date().toISOString(),
    options, global: mesures(lignes),
    par_confiance: grouper(lignes, (l) => l.confiance),
    par_palier: grouper(lignes, (l) => l.palier),
    par_annee: grouper(lignes, (l) => l.annee),
    par_departement: grouper(lignes, (l) => l.dep),
  }, null, 1) + "\n");
  console.log(`Écrit dans audit/backtest/rapport${suffixe}.txt`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
