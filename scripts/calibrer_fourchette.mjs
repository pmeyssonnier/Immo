// Calibrage de la fourchette d'estimation.
//
// LE CONSTAT. Le backtest a mesure que le vrai prix tombe dans la fourchette
// affichee 20,9 % du temps. Une fourchette presentee comme une marge
// d'incertitude devrait en couvrir 80 %. Elle ne se trompe pas un peu : elle
// repond a une autre question que celle qu'on lui pose.
//
// LA CAUSE. js/estimation.js calcule aujourd'hui 1,57 x IQR / racine(n), qui est
// l'intervalle de confiance de la MEDIANE. Traduit : « connait-on bien le prix
// au m2 MOYEN de cette commune ? » -- oui, tres bien, il y a des centaines de
// ventes, d'ou le racine(n) qui ecrase tout et fait taper le plancher des 4 %.
// Or l'utilisateur demande : « ou va tomber le prix de MON bien ? » Deux maisons
// de 100 m2 dans la meme rue ne se vendent pas au meme prix, et cette
// dispersion-la n'est nulle part dans le calcul.
//
// LE REMEDE, mesure au lieu d'etre devine. Pour chaque vente du backtest on
// connait l'estimation et le prix reel. On calcule le rapport r = reel / estime.
// Si les ventes de fiabilite « bonne » donnent quantile10(r) = 0,72 et
// quantile90(r) = 1,45, alors afficher [estime x 0,72 ; estime x 1,45] contient
// le vrai prix 80 % du temps PAR CONSTRUCTION -- c'est ce qu'on vient de
// compter.
//
// LE PIEGE, et c'est le seul qui compte ici : mesurer la couverture sur les
// ventes qui ont servi a fixer les coefficients donne la cible par definition et
// ne prouve rien. La calibration est donc HORS ECHANTILLON :
//
//     coefficients calcules sur les annees testables SAUF la derniere,
//     couverture verifiee sur la derniere annee, jamais vue par le calibrage.
//
// C'est ce second chiffre, et lui seul, qui a le droit d'etre affiche a l'ecran.
//
// Ce script ne modifie ni le moteur ni les donnees : il mesure et il imprime.
//
// Usage :
//   node scripts/calibrer_fourchette.mjs [--echantillon 60000] [--graine 1]

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { chargerTout, backtester, quantile } from "./backtester.mjs";

const RACINE = join(dirname(fileURLToPath(import.meta.url)), "..");

// Les couvertures qu'on sait proposer. Une fourchette honnete a 80 % sera large ;
// c'est un arbitrage commercial, pas technique, d'ou le tableau plutot qu'un
// chiffre impose.
const CIBLES = [
  { pct: 50, libelle: "1 fois sur 2" },
  { pct: 67, libelle: "2 fois sur 3" },
  { pct: 80, libelle: "4 fois sur 5" },
  { pct: 90, libelle: "9 fois sur 10" },
];

// Bien d'exemple, pour que les largeurs parlent en euros et pas en coefficients.
const EXEMPLE = 250000;

// En dessous, un quantile ne veut plus rien dire et on le dit plutot que de
// publier un coefficient tire de trois ventes.
const MIN_LIGNES = 200;

/**
 * La cle de calibrage. Le palier 2 (bandes departementales) est sorti du lot :
 * le moteur lui attribue la confiance « faible », mais son erreur mediane est de
 * 40 % contre 33 % pour un « faible » ordinaire, et sa couverture s'effondre a
 * 11,8 %. Deux populations differentes derriere une meme etiquette : les mettre
 * ensemble donnerait une fourchette trop large pour l'une et trop etroite pour
 * l'autre.
 */
export function cleDe(ligne) {
  return ligne.palier === 2 ? "bandes" : ligne.confiance;
}

/** Rapports reel/estime d'un groupe, tries -- la matiere premiere du calibrage. */
export function rapports(lignes) {
  return lignes
    .filter((l) => l.estime > 0 && l.reel > 0)
    .map((l) => l.reel / l.estime)
    .sort((a, b) => a - b);
}

/**
 * Coefficients [bas, haut] pour une couverture cible, centres sur la mediane :
 * on laisse la meme proportion de depassements de chaque cote.
 *
 * Ils ne seront PAS symetriques autour de 1, et c'est voulu : le moteur
 * sur-evalue en moyenne (biais moyen +14,7 %), et une fourchette calee sur les
 * rapports observes absorbe ce biais au lieu de le dissimuler.
 */
export function coefficients(rapportsTries, cible) {
  const reste = (100 - cible) / 200;          // moitie de chaque cote
  return [quantile(rapportsTries, reste), quantile(rapportsTries, 1 - reste)];
}

/** Part des ventes dont le prix reel tombe dans [estime x bas, estime x haut]. */
export function couverture(lignes, [bas, haut]) {
  const utiles = lignes.filter((l) => l.estime > 0 && l.reel > 0);
  if (!utiles.length) return null;
  const dedans = utiles.filter((l) => l.reel >= l.estime * bas && l.reel <= l.estime * haut);
  return 100 * dedans.length / utiles.length;
}

/**
 * Le calibrage complet.
 * Renvoie, par cible et par cle, les coefficients et leur couverture verifiee
 * sur une annee que le calibrage n'a jamais vue.
 */
export function calibrer(lignes) {
  const chiffrees = lignes.filter((l) => l.estime > 0 && l.reel > 0);
  const annees = [...new Set(chiffrees.map((l) => l.annee))].sort();
  if (annees.length < 2) {
    throw new Error("il faut au moins deux annees testables pour calibrer hors echantillon");
  }
  const anneeTest = annees[annees.length - 1];
  const apprentissage = chiffrees.filter((l) => l.annee < anneeTest);
  const verification = chiffrees.filter((l) => l.annee === anneeTest);

  const grouper = (lot) => {
    const m = new Map();
    for (const l of lot) {
      const c = cleDe(l);
      if (!m.has(c)) m.set(c, []);
      m.get(c).push(l);
    }
    return m;
  };
  const groupesApprentissage = grouper(apprentissage);
  const groupesVerification = grouper(verification);
  const cles = [...new Set([...groupesApprentissage.keys(), ...groupesVerification.keys()])].sort();

  const resultat = {
    annees_apprentissage: annees.slice(0, -1),
    annee_verification: anneeTest,
    n_apprentissage: apprentissage.length,
    n_verification: verification.length,
    cibles: {},
  };

  for (const { pct, libelle } of CIBLES) {
    const parCle = {};
    for (const cle of cles) {
      const appr = groupesApprentissage.get(cle) || [];
      const veri = groupesVerification.get(cle) || [];
      if (appr.length < MIN_LIGNES) {
        parCle[cle] = { n_apprentissage: appr.length, n_verification: veri.length,
                        insuffisant: true };
        continue;
      }
      const coef = coefficients(rapports(appr), pct);
      parCle[cle] = {
        n_apprentissage: appr.length,
        n_verification: veri.length,
        bas: coef[0],
        haut: coef[1],
        // Ce chiffre-la vaut la cible par construction : il ne prouve rien, il
        // n'est la que pour rendre visible l'ecart avec le suivant.
        couverture_apprentissage: couverture(appr, coef),
        // Le seul chiffre publiable.
        couverture_verification: veri.length ? couverture(veri, coef) : null,
        exemple_bas: Math.round(EXEMPLE * coef[0]),
        exemple_haut: Math.round(EXEMPLE * coef[1]),
      };
    }
    // Couverture d'ensemble : chaque vente jugee avec les coefficients de SA cle.
    const parCleCoef = new Map(
      Object.entries(parCle).filter(([, v]) => !v.insuffisant)
        .map(([k, v]) => [k, [v.bas, v.haut]]));
    const jugeables = verification.filter((l) => parCleCoef.has(cleDe(l)));
    const dedans = jugeables.filter((l) => {
      const [bas, haut] = parCleCoef.get(cleDe(l));
      return l.reel >= l.estime * bas && l.reel <= l.estime * haut;
    });
    resultat.cibles[pct] = {
      libelle,
      par_cle: parCle,
      couverture_globale_verification: jugeables.length
        ? 100 * dedans.length / jugeables.length : null,
      n_jugeables: jugeables.length,
    };
  }
  return resultat;
}

// --------------------------------------------------------------------------
// Restitution
// --------------------------------------------------------------------------

const nb = (x, d = 1) => (x === null || x === undefined || Number.isNaN(x)
  ? "—" : Number(x).toFixed(d));
const euros = (x) => Math.round(x).toLocaleString("fr-FR") + " €";

function rapport(calibration, options) {
  const L = [];
  L.push(`Calibrage de la fourchette — ${new Date().toISOString().slice(0, 16).replace("T", " ")}`);
  L.push("=".repeat(74));
  L.push("");
  L.push(`Echantillon : ${options.taille} ventes (graine ${options.graine})`);
  L.push(`Coefficients calculés sur ${calibration.annees_apprentissage.join(", ")}`
    + `  —  ${calibration.n_apprentissage} ventes`);
  L.push(`Couverture VÉRIFIÉE sur ${calibration.annee_verification}`
    + `, jamais vue par le calibrage  —  ${calibration.n_verification} ventes`);
  L.push("");
  L.push(`Bien d'exemple : ${euros(EXEMPLE)}`);
  L.push("");

  L.push("CE QU'ON PEUT PROMETTRE");
  L.push("-".repeat(74));
  L.push("  promesse         couverture réelle   fourchette sur un bien à 250 000 €");
  L.push("                   (hors échantillon)   fiabilité bonne");
  for (const { pct, libelle } of CIBLES) {
    const c = calibration.cibles[pct];
    const b = c.par_cle.bonne;
    const exemple = b && !b.insuffisant
      ? `${euros(b.exemple_bas)} – ${euros(b.exemple_haut)}` : "—";
    L.push(`  ${(libelle + ` (${pct} %)`).padEnd(18)}`
      + `${(nb(c.couverture_globale_verification) + " %").padStart(10)}`
      + `          ${exemple}`);
  }
  L.push("");

  for (const { pct, libelle } of CIBLES) {
    const c = calibration.cibles[pct];
    L.push(`DÉTAIL — ${libelle} (${pct} %)`);
    L.push("-".repeat(74));
    L.push("  clé          n appr.    coef. bas   coef. haut   couv. vérif."
      + "   exemple 250 k€");
    for (const [cle, v] of Object.entries(c.par_cle)) {
      if (v.insuffisant) {
        L.push(`  ${cle.padEnd(12)}${String(v.n_apprentissage).padStart(7)}`
          + "    — trop peu de ventes pour calibrer honnêtement");
        continue;
      }
      L.push(`  ${cle.padEnd(12)}${String(v.n_apprentissage).padStart(7)}`
        + `${nb(v.bas, 3).padStart(13)}${nb(v.haut, 3).padStart(13)}`
        + `${(nb(v.couverture_verification) + " %").padStart(15)}`
        + `   ${euros(v.exemple_bas)} – ${euros(v.exemple_haut)}`);
    }
    L.push("");
  }
  return L.join("\n");
}

function main() {
  const args = process.argv.slice(2);
  const valeur = (nom, defaut) => {
    const i = args.indexOf(nom);
    return i >= 0 && args[i + 1] ? Number(args[i + 1]) : defaut;
  };
  const options = {
    taille: valeur("--echantillon", 60000),
    graine: valeur("--graine", 1),
  };

  process.stderr.write("chargement des données…\n");
  const monde = chargerTout();
  process.stderr.write(`backtest sur ${options.taille} ventes…\n`);
  const lignes = backtester({ monde, ...options });

  const calibration = calibrer(lignes);
  const texte = rapport(calibration, options);
  console.log(texte);

  const dossier = join(RACINE, "audit", "backtest");
  mkdirSync(dossier, { recursive: true });
  writeFileSync(join(dossier, "calibration.txt"), texte + "\n");
  writeFileSync(join(dossier, "calibration.json"), JSON.stringify({
    genere_le: new Date().toISOString(), options, exemple: EXEMPLE, ...calibration,
  }, null, 1) + "\n");
  process.stderr.write("\naudit/backtest/calibration.{txt,json} écrits.\n");
}

if (import.meta.url === `file://${process.argv[1]}`) main();
