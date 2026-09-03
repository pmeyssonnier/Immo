// ---------------------------------------------------------------------------
// Fabrique les icônes de l'application.
// ---------------------------------------------------------------------------
//
// /!\ VOUS N'AVEZ PAS À LANCER CE SCRIPT.
//
// Les fichiers qu'il produit sont DÉJÀ dans le dépôt (dossier icones/ et
// manifest.json). Ce script n'existe que pour pouvoir redessiner l'icône un
// jour sans repartir de zéro.
//
// Comment ça marche : il n'y a pas d'outil de dessin sur cette machine (ni
// Pillow, ni ImageMagick, ni Inkscape). On se sert donc du navigateur : le
// dessin est décrit en SVG, Chromium l'affiche, et on prend une photo de
// l'écran à la taille exacte voulue.
//
// Pour le relancer :
//     npm install playwright-core
//     node scripts/generer_icones.mjs
// Variables d'environnement facultatives :
//     CHROME=/chemin/vers/chrome     (défaut : le Chromium de Playwright)
//     SORTIE=/un/dossier             (où écrire la planche de contrôle)
//
// Testé avec chromium-1194. Une autre version peut décaler un pixel de lissage
// sur les bords : sans conséquence, et c'est pourquoi aucun test ne compare les
// images octet par octet.
//
// Décisions assumées, pour que personne ne les « corrige » plus tard :
//   - PAS de favicon.ico : les navigateurs ne le cherchent qu'à la racine du
//     domaine (pmeyssonnier.github.io), hors de notre dépôt. Avec une balise
//     <link> explicite, un PNG fait mieux.
//   - PAS d'apple-touch-icon en 57/60/72/76/114/120/144/152/167 : mort depuis
//     iOS 8, un seul fichier de 180 px suffit.
//   - PAS de browserconfig.xml : les tuiles Windows n'existent plus.
// ---------------------------------------------------------------------------

import { chromium } from "playwright-core";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RACINE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DOSSIER_ICONES = path.join(RACINE, "icones");
const SORTIE = process.env.SORTIE || RACINE;
const CHEMIN_CHROME = process.env.CHROME
  || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

// --- Le dessin, décrit UNE SEULE FOIS --------------------------------------
//
// Une maison blanche au toit orangé sur le bleu de l'application.
// Deux formes pleines, aucun trait : un trait fin disparaît ou devient une
// bouillie grise à 16 px. Ni porte ni fenêtre, pour la même raison — à 16 px
// le bloc blanc ne fait que 4 px de haut.
//
// Le débord de l'avant-toit de part et d'autre des murs (116→396 contre
// 164→348) est LE détail qui fait lire « maison » en tout petit. Sans lui, on
// voit un chapeau posé sur une boîte.
//
// La couleur du toit est un choix de CONTRASTE, pas de goût. Sur le bleu
// #1f4e79 : #e31a1c donne 2,2:1 et #fc4e2a 2,6:1 — tous deux illisibles.
// #fd8d3c donne 3,8:1 et passe le seuil de 3:1 exigé pour un élément non
// textuel. Les murs blancs donnent 14,6:1.
//
// Zone de sécurité Android : le lanceur découpe un cercle centré de rayon
// 204,8. Points les plus éloignés du centre — sommet du toit 125, avant-toits
// 140,1, bas des murs 154,4 : tous largement à l'intérieur. Un seul dessin
// suffit donc pour toutes les variantes.

const BLEU = "#1f4e79";     // = --accent
const ORANGE = "#fd8d3c";   // 5e couleur de la palette de la carte
const BLANC = "#ffffff";

function svgIcone(rayonCoins) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <rect x="0" y="0" width="512" height="512" rx="${rayonCoins}" fill="${BLEU}"/>
  <path d="M256 132 L396 252 L116 252 Z" fill="${ORANGE}"/>
  <rect x="164" y="252" width="184" height="128" rx="12" fill="${BLANC}"/>
</svg>`;
}

// --- Ce qu'il faut produire -------------------------------------------------
//
// « plein cadre » (rayon 0) = aucun pixel transparent. C'est indispensable pour
// iOS, qui ne gère pas la transparence et remplit le vide avec du NOIR : une
// icône aux coins arrondis transparents deviendrait une icône aux coins noirs.
// iOS applique lui-même son arrondi ; lui donner une image déjà arrondie
// produirait un double arrondi. Android fait pareil avec l'icône « maskable ».

const RAYON_ARRONDI = 96;   // 18,75 % — poids visuel proche du squircle iOS

const PRODUCTIONS = [
  { fichier: "favicon-16.png", taille: 16, rayon: RAYON_ARRONDI },
  { fichier: "favicon-32.png", taille: 32, rayon: RAYON_ARRONDI },
  { fichier: "icone-192.png", taille: 192, rayon: RAYON_ARRONDI },
  { fichier: "icone-512.png", taille: 512, rayon: RAYON_ARRONDI },
  { fichier: "apple-touch-icon.png", taille: 180, rayon: 0 },
  { fichier: "icone-maskable-512.png", taille: 512, rayon: 0 },
];

// --- Lecture de l'en-tête d'un PNG, sans bibliothèque ----------------------
// La largeur et la hauteur sont deux entiers de 4 octets, gros-boutistes, aux
// positions 16 et 20 du fichier : 8 octets de signature, puis 4 de longueur de
// bloc, puis 4 pour le nom du bloc « IHDR ».
function dimensionsPng(octets) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!octets.subarray(0, 8).equals(signature)) throw new Error("ce n'est pas un PNG");
  return { largeur: octets.readUInt32BE(16), hauteur: octets.readUInt32BE(20) };
}

// --- Rendu : obtenir EXACTEMENT N × N pixels -------------------------------
// On ne photographie pas un élément (la capture d'élément arrondit les pixels
// fractionnaires). On règle la fenêtre à N × N et on photographie la page
// entière : le résultat fait N × N par construction.
async function rendre(navigateur, svg, taille) {
  const page = await navigateur.newPage({
    viewport: { width: taille, height: taille },
    deviceScaleFactor: 1,
  });
  await page.setContent(`<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    html, body { margin: 0; padding: 0; overflow: hidden; background: transparent; }
    svg { display: block; width: 100%; height: 100%; }
  </style></head><body>${svg}</body></html>`);
  // omitBackground : les coins arrondis sortent réellement transparents.
  const image = await page.screenshot({ omitBackground: true });
  await page.close();
  return image;
}

// --- Planche de contrôle ---------------------------------------------------
// Une image unique qui montre l'icône à toutes les tailles, sur fond clair et
// sombre, plus les deux découpes que lui feront subir les téléphones. C'est là
// qu'on juge la lisibilité à 16 px — à l'œil, pas en théorie.
async function plancheDeControle(navigateur, svgArrondi, svgPlein) {
  const tailles = [16, 32, 64, 128, 180];
  const rangee = (svg, fond, couleurTexte) => `
    <div class="bande" style="background:${fond};color:${couleurTexte}">
      ${tailles.map((t) => `<figure>
        <div style="width:${t}px;height:${t}px">${svg}</div>
        <figcaption>${t} px</figcaption>
      </figure>`).join("")}
    </div>`;

  const page = await navigateur.newPage({
    viewport: { width: 900, height: 620 }, deviceScaleFactor: 2,
  });
  await page.setContent(`<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    body { margin:0; font:13px system-ui, sans-serif; background:#fff; }
    h2 { font-size:12px; text-transform:uppercase; letter-spacing:.5px;
         color:#5b6875; margin:18px 20px 6px; }
    .bande { display:flex; align-items:flex-end; gap:26px; padding:18px 20px; }
    figure { margin:0; text-align:center; }
    figure div { display:flex; align-items:center; justify-content:center; }
    figcaption { font-size:10px; margin-top:8px; opacity:.7; }
    svg { display:block; width:100%; height:100%; }
    .masques { display:flex; gap:26px; padding:10px 20px 20px; align-items:flex-end; }
    .masque { width:120px; height:120px; overflow:hidden; }
    .cercle { border-radius:50%; }
    .squircle { border-radius:26%; }
  </style></head><body>
    <h2>Sur fond clair (onglet de navigateur)</h2>
    ${rangee(svgArrondi, "#f4f5f7", "#1c2430")}
    <h2>Sur fond sombre (mode nuit)</h2>
    ${rangee(svgArrondi, "#1c2430", "#f4f5f7")}
    <h2>Découpes appliquées par les téléphones (à partir du fichier plein cadre)</h2>
    <div class="masques">
      <figure><div class="masque cercle">${svgPlein}</div>
        <figcaption>cercle — Android / Pixel</figcaption></figure>
      <figure><div class="masque squircle">${svgPlein}</div>
        <figcaption>squircle — iOS / Samsung</figcaption></figure>
      <figure><div class="masque">${svgPlein}</div>
        <figcaption>carré plein — le fichier livré</figcaption></figure>
    </div>
  </body></html>`);
  const image = await page.screenshot({ fullPage: true });
  await page.close();
  return image;
}

// --- Programme principal ---------------------------------------------------

async function main() {
  console.log("Fabrication des icônes.");
  console.log("Rappel : les fichiers produits sont déjà dans le dépôt ;");
  console.log("ce script ne sert qu'à les redessiner.\n");

  await mkdir(DOSSIER_ICONES, { recursive: true });

  const svgArrondi = svgIcone(RAYON_ARRONDI);
  const svgPlein = svgIcone(0);

  // Le SVG est un produit comme les autres : on l'écrit d'abord.
  const enTete = "<!-- Produit par scripts/generer_icones.mjs "
    + "- ne pas modifier a la main -->\n";
  await writeFile(path.join(DOSSIER_ICONES, "icone.svg"), enTete + svgArrondi + "\n");
  console.log("  icones/icone.svg");

  const navigateur = await chromium.launch({
    executablePath: CHEMIN_CHROME,
    args: [
      "--no-sandbox",
      // sans profil sRGB forcé, un profil écran décale les aplats d'un ou deux niveaux
      "--force-color-profile=srgb",
      "--hide-scrollbars",
      // le rendu logiciel est plus reproductible que le rendu par carte graphique
      "--disable-gpu",
    ],
  });

  try {
    for (const { fichier, taille, rayon } of PRODUCTIONS) {
      const image = await rendre(navigateur, svgIcone(rayon), taille);
      const chemin = path.join(DOSSIER_ICONES, fichier);
      await writeFile(chemin, image);

      // Auto-vérification : on relit le fichier écrit et on refuse une taille fausse.
      const { largeur, hauteur } = dimensionsPng(await readFile(chemin));
      if (largeur !== taille || hauteur !== taille) {
        throw new Error(`${fichier} : ${largeur}x${hauteur} au lieu de ${taille}x${taille}`);
      }
      console.log(`  icones/${fichier.padEnd(24)} ${largeur}x${hauteur}`
        + `  ${String(image.length).padStart(6)} octets`
        + `  ${rayon === 0 ? "plein cadre" : "coins arrondis"}`);
    }

    const planche = await plancheDeControle(navigateur, svgArrondi, svgPlein);
    const cheminPlanche = path.join(SORTIE, "apercu-icones.png");
    await writeFile(cheminPlanche, planche);
    console.log(`\nPlanche de contrôle : ${cheminPlanche}`);
    console.log("(elle n'est pas enregistrée dans le dépôt : c'est un outil de relecture)");
  } finally {
    await navigateur.close();
  }
  console.log("\nTerminé.");
}

main();
