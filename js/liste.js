// Panneau de gauche : la recherche et la liste des communes.

import { CONFIG, nomDepartement } from "./config.js";
import { echapper, eurosParM2, nombre } from "./format.js";
import { couleurPrix } from "./config.js";
import { chercher, indexerCommunes, LIMITE_RESULTATS } from "./recherche.js";

let champRecherche = null;
let conteneurListe = null;
let compteur = null;
// Empreinte du dernier rendu : elle evite de reconstruire les milliers de
// lignes a chaque deplacement de la carte (ce qui ferait sauter le defilement).
let derniereEmpreinte = null;
// Departements que l'utilisateur a ouverts a la main. Avec quatorze groupes et
// pres de quatre mille communes, tout deplier au demarrage donnerait une liste
// interminable : on part donc replie, et on se souvient de ce qui a ete ouvert.
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

// L'index de recherche est garde tant que le tableau des communes est le meme
// objet : il n'est donc reconstruit que si les donnees sont rechargees.
let indexRecherche = null;
let communesIndexees = null;

function index(communes) {
  if (communes !== communesIndexees) {
    communesIndexees = communes;
    indexRecherche = indexerCommunes(communes);
  }
  return indexRecherche;
}

/**
 * Une ligne de commune.
 *
 * Le nom du departement n'est passe qu'en mode resultats : dans la liste
 * groupee il est deja porte par le titre du groupe, juste au-dessus.
 *
 * Il est pose dans un span FRERE de .nom, et non dedans. Ce n'est pas un detail
 * de mise en page : la verification navigateur lit le texte de .nom et le
 * compare a « Nimes » a l'identique. Un departement glisse a l'interieur en
 * ferait « Nimes Gard », et le controle tomberait sans que rien ne soit casse.
 */
function ligneCommune(commune, etat, seuils, nomDep) {
  const actif = commune.code === etat.communeSelectionnee ? " class=\"actif\"" : "";
  const prix = commune.m2_med === null
    ? `<span class="sans-donnees">données insuffisantes</span>`
    : eurosParM2(commune.m2_med);
  const departement = nomDep
    ? `<span class="dep-resultat">${echapper(nomDep)}</span>`
    : "";
  return `<li${actif} data-code="${echapper(commune.code)}" tabindex="0">
    <span class="pastille" style="background:${couleurPrix(commune.m2_med, seuils)}"></span>
    <span class="nom">${echapper(commune.nom)}</span>${departement}
    <span class="stats">${prix}<em>${nombre(commune.n)} vente${commune.n > 1 ? "s" : ""}</em></span>
  </li>`;
}

/** Mode par defaut : toutes les communes, groupees par departement et repliees. */
function morceauxGroupes(etat, seuils) {
  const parDepartement = {};
  for (const commune of etat.communes) {
    (parDepartement[commune.dep] = parDepartement[commune.dep] || []).push(commune);
  }
  const depDeLaSelection = etat.communeSelectionnee
    ? (etat.communes.find((c) => c.code === etat.communeSelectionnee) || {}).dep
    : null;

  const morceaux = [];
  for (const { code: dep, nom: nomDep } of CONFIG.DEPARTEMENTS) {
    const liste = parDepartement[dep];
    if (!liste || !liste.length) continue;
    liste.sort((a, b) => a.nom.localeCompare(b.nom, "fr"));

    // Un groupe s'ouvre s'il contient la commune selectionnee, ou si
    // l'utilisateur l'a ouvert lui-meme.
    const ouvert = dep === depDeLaSelection || departementsOuverts.has(dep);

    // Le prix median du departement est deja calcule par le robot : on
    // l'affiche sur la ligne du groupe, pour qu'il se lise sans rien deplier.
    const infosDep = (etat.meta.departements || {})[dep];
    const medianeDep = infosDep ? infosDep.prix_m2_median : null;
    const ventesDep = infosDep ? infosDep.nb_ventes : 0;

    morceaux.push(`<details data-dep="${echapper(dep)}"${ouvert ? " open" : ""}>
      <summary>
        <span class="pastille" style="background:${couleurPrix(medianeDep, seuils)}"></span>
        <span class="nom-dep" title="${echapper(nomDep)} — ${liste.length} communes">${echapper(nomDep)}</span>
        <span class="stats-dep">
          <strong>${medianeDep === null ? "—" : eurosParM2(medianeDep)}</strong>
          <em>${nombre(ventesDep)} vente${ventesDep > 1 ? "s" : ""}</em>
        </span>
      </summary>
      <ul>`);
    for (const commune of liste) morceaux.push(ligneCommune(commune, etat, seuils, null));
    morceaux.push("</ul></details>");
  }
  return morceaux;
}

/**
 * Mode recherche : une liste plate, les meilleurs resultats en tete.
 *
 * On aplatit parce qu'un classement par pertinence n'a de sens qu'a plat :
 * garder les groupes obligerait a classer les departements entre eux, ce qui
 * n'a aucun rapport avec ce qui est cherche. Le nom du departement passe donc
 * sur chaque ligne, et ce n'est pas decoratif : 95 communes de ces quatorze
 * departements portent le meme nom qu'une autre, dont quatre « La Garde ».
 */
function morceauxResultats(resultats, etat, seuils) {
  const morceaux = ["<ul class=\"resultats\">"];
  for (const { commune } of resultats) {
    morceaux.push(ligneCommune(commune, etat, seuils, nomDepartement(commune.dep)));
  }
  morceaux.push("</ul>");
  return morceaux;
}

/** Ce qui s'affiche au-dessus de la liste. */
function texteDuCompteur(nbTrouves, nbAffiches) {
  if (!nbTrouves) return "aucune commune trouvée";
  const pluriel = nbTrouves > 1 ? "s" : "";
  // Annoncer « 3328 communes trouvées » en n'en montrant que deux cents serait
  // faux. On le dit sur la meme ligne, sans rien ajouter a l'ecran.
  return nbAffiches < nbTrouves
    ? `${nombre(nbAffiches)} affichées sur ${nombre(nbTrouves)} trouvées`
    : `${nbTrouves} commune${pluriel} trouvée${pluriel}`;
}

export function rendre(etat) {
  if (!conteneurListe || !etat.communes.length) return;

  const empreinte = [etat.recherche, etat.communeSelectionnee, etat.communes.length].join("\u0001");
  if (empreinte === derniereEmpreinte) return;
  const selectionSeuleAChange = derniereEmpreinte !== null
    && derniereEmpreinte.split("\u0001")[0] === etat.recherche;
  const defilement = conteneurListe.scrollTop;
  derniereEmpreinte = empreinte;

  const seuils = etat.meta.seuils_couleurs || [];
  const saisie = etat.recherche.trim();

  // On demande TOUS les resultats pour pouvoir annoncer le vrai nombre, puis
  // on n'affiche que les premiers. Le classement porte de toute facon sur
  // l'ensemble : il n'y a rien a economiser en tronquant plus tot.
  const tous = saisie ? chercher(index(etat.communes), saisie, Infinity) : null;

  let morceaux;
  if (tous === null) {
    compteur.textContent = `${nombre(etat.communes.length)} communes`;
    morceaux = morceauxGroupes(etat, seuils);
  } else {
    const affiches = tous.slice(0, LIMITE_RESULTATS);
    compteur.textContent = texteDuCompteur(tous.length, affiches.length);
    // Le message d'absence se decide sur le NOMBRE DE RESULTATS, jamais sur la
    // longueur de "morceaux" : la liste plate y pose toujours au moins sa
    // balise ouvrante, et le message ne s'afficherait plus jamais.
    morceaux = affiches.length ? morceauxResultats(affiches, etat, seuils) : [];
  }

  if (!morceaux.length) {
    // La saisie de l'utilisateur : le seul texte vraiment quelconque de
    // toute l'application, donc le point d'injection le plus exposé.
    morceaux.push(`<p class="vide">Aucune commune ne correspond à « ${echapper(etat.recherche)} ».</p>`);
  }
  conteneurListe.innerHTML = morceaux.join("");

  // On repart d'ou l'on etait, sauf si la recherche vient de changer.
  if (selectionSeuleAChange) conteneurListe.scrollTop = defilement;
  const actif = conteneurListe.querySelector("li.actif");
  if (actif) actif.scrollIntoView({ block: "nearest" });
}
