// Panneau de gauche : la recherche et la liste des communes.

import { CONFIG } from "./config.js";
import { eurosParM2, nombre, sansAccents } from "./format.js";
import { couleurPrix } from "./config.js";

let champRecherche = null;
let conteneurListe = null;
let compteur = null;
// Empreinte du dernier rendu : elle evite de reconstruire les 692 lignes a
// chaque deplacement de la carte (ce qui ferait sauter le defilement).
let derniereEmpreinte = null;
// Departements que l'utilisateur a ouverts a la main. Avec 8 groupes et 2 300
// communes, tout deplier au demarrage donnerait une liste interminable : on
// part donc replie, et on se souvient de ce qui a ete ouvert.
const departementsOuverts = new Set();

export function initialiser(racine, actions) {
  racine.innerHTML = `
    <div class="recherche">
      <input type="search" id="champ-recherche" placeholder="Rechercher une commune…"
             autocomplete="off" aria-label="Rechercher une commune">
    </div>
    <p class="compteur" id="compteur-communes"></p>
    <div class="liste-communes" id="liste-communes"></div>
  `;
  champRecherche = racine.querySelector("#champ-recherche");
  conteneurListe = racine.querySelector("#liste-communes");
  compteur = racine.querySelector("#compteur-communes");

  // On ne reconstruit jamais le champ de recherche : sinon il perdrait le focus
  // a chaque lettre tapee.
  champRecherche.addEventListener("input", () => {
    actions.changerRecherche(champRecherche.value);
  });

  conteneurListe.addEventListener("click", (evenement) => {
    const ligne = evenement.target.closest("[data-code]");
    if (ligne) actions.selectionnerCommune(ligne.dataset.code);
  });

  // On note ce que l'utilisateur ouvre ou ferme, pour le restituer au prochain
  // affichage. L'ouverture elle-meme est faite par le navigateur : aucun
  // reaffichage n'est declenche ici.
  conteneurListe.addEventListener("toggle", (evenement) => {
    const bloc = evenement.target;
    if (bloc.tagName !== "DETAILS") return;
    if (bloc.open) departementsOuverts.add(bloc.dataset.dep);
    else departementsOuverts.delete(bloc.dataset.dep);
  }, true);

  return {
    focus: () => champRecherche.focus(),
  };
}

function correspond(commune, recherche) {
  if (!recherche) return true;
  return sansAccents(commune.nom).includes(recherche)
    || commune.code.startsWith(recherche);
}

export function rendre(etat) {
  if (!conteneurListe || !etat.communes.length) return;

  const empreinte = [etat.recherche, etat.communeSelectionnee, etat.communes.length].join("\u0001");
  if (empreinte === derniereEmpreinte) return;
  const selectionSeuleAChange = derniereEmpreinte !== null
    && derniereEmpreinte.split("\u0001")[0] === etat.recherche;
  const defilement = conteneurListe.scrollTop;
  derniereEmpreinte = empreinte;

  const recherche = sansAccents(etat.recherche.trim());
  const seuils = etat.meta.seuils_couleurs || [];
  const parDepartement = {};

  for (const commune of etat.communes) {
    if (!correspond(commune, recherche)) continue;
    (parDepartement[commune.dep] = parDepartement[commune.dep] || []).push(commune);
  }

  const total = Object.values(parDepartement).reduce((s, l) => s + l.length, 0);
  compteur.textContent = recherche
    ? `${total} commune${total > 1 ? "s" : ""} trouvée${total > 1 ? "s" : ""}`
    : `${etat.communes.length} communes`;

  const depDeLaSelection = etat.communeSelectionnee
    ? (etat.communes.find((c) => c.code === etat.communeSelectionnee) || {}).dep
    : null;

  const morceaux = [];
  for (const { code: dep, nom: nomDep } of CONFIG.DEPARTEMENTS) {
    const liste = parDepartement[dep];
    if (!liste || !liste.length) continue;
    liste.sort((a, b) => a.nom.localeCompare(b.nom, "fr"));

    // Un groupe s'ouvre s'il contient un resultat de recherche, s'il contient
    // la commune selectionnee, ou si l'utilisateur l'a ouvert lui-meme.
    const ouvert = Boolean(recherche) || dep === depDeLaSelection
      || departementsOuverts.has(dep);

    morceaux.push(`<details data-dep="${dep}"${ouvert ? " open" : ""}>
      <summary>${nomDep} <span class="badge">${liste.length}</span></summary>
      <ul>`);
    for (const commune of liste) {
      const actif = commune.code === etat.communeSelectionnee ? " class=\"actif\"" : "";
      const couleur = couleurPrix(commune.m2_med, seuils);
      const prix = commune.m2_med === null
        ? `<span class="sans-donnees">données insuffisantes</span>`
        : eurosParM2(commune.m2_med);
      morceaux.push(`<li${actif} data-code="${commune.code}" tabindex="0">
        <span class="pastille" style="background:${couleur}"></span>
        <span class="nom">${commune.nom}</span>
        <span class="stats">${prix}<em>${nombre(commune.n)} vente${commune.n > 1 ? "s" : ""}</em></span>
      </li>`);
    }
    morceaux.push("</ul></details>");
  }

  if (!morceaux.length) {
    morceaux.push(`<p class="vide">Aucune commune ne correspond à « ${etat.recherche} ».</p>`);
  }
  conteneurListe.innerHTML = morceaux.join("");

  // On repart d'ou l'on etait, sauf si la recherche vient de changer.
  if (selectionSeuleAChange) conteneurListe.scrollTop = defilement;
  const actif = conteneurListe.querySelector("li.actif");
  if (actif) actif.scrollIntoView({ block: "nearest" });
}
