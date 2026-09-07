// Panneau de droite : fiche de la commune + estimateur + ventes comparables.

import { echapper, euros, eurosParM2, etoiles, lienGoogleMaps, lienStreetView, moisEnTexte,
  nombre, surface } from "./format.js";
import { REGLAGES, amplitude } from "./estimation.js";
import { adresseLisible } from "./adresses.js";

let racineElement = null;
let actionsElement = null;
let dernierResultat = null;
// Meme precaution que pour la liste : sans cela, un simple deplacement de la
// carte reconstruirait le formulaire et ferait perdre le curseur a l'utilisateur
// en pleine saisie.
let derniereEmpreinte = null;

// Le premier element servait a AFFICHER un niveau (« Bonne », « Moyenne »...).
// L'ecran montre desormais l'amplitude reelle a la place : un pourcentage dit ce
// que « Bonne » ne disait pas, c'est-a-dire de combien on peut se tromper. Les
// libelles restent pour deux usages ou ils ont encore un sens : le conseil qui
// accompagne le chiffre, et le code couleur (vert / orange / rouge).
const LIBELLES_CONFIANCE = {
  bonne: ["Bonne", "Beaucoup de ventes très comparables dans la commune même."],
  moyenne: ["Moyenne", "Assez de ventes comparables, mais moins nombreuses ou moins proches."],
  faible: ["Faible", "Peu de comparables dans la commune même : à confronter impérativement avec votre connaissance du terrain."],
  insuffisante: ["Insuffisante", "Pas assez de ventes pour avancer un chiffre honnêtement."],
};

/** « -29 % / +26 % » -- l'ecart possible, signe des deux cotes. */
function amplitudeEnTexte(resultat) {
  const bornes = amplitude(resultat);
  if (!bornes) return null;
  const signe = (n) => (n > 0 ? "+" : "\u2212") + Math.abs(n) + "\u00a0%";
  return `${signe(bornes.bas)} / ${signe(bornes.haut)}`;
}

const LIBELLES_PALIER = {
  0: "ventes de la commune",
  1: "ventes de la commune et des communes limitrophes",
  2: "moyennes du département par tranche de surface",
};

export function initialiser(racine, actions) {
  racineElement = racine;
  actionsElement = actions;

  racine.addEventListener("click", (evenement) => {
    if (evenement.target.closest("#fermer-panneau")) { actions.fermer(); return; }
    if (evenement.target.closest("#copier-synthese")) { copierSynthese(); return; }
    const bouton = evenement.target.closest("[data-comparable]");
    if (bouton && dernierResultat) {
      actions.voirVente(dernierResultat.comparables[Number(bouton.dataset.comparable)]);
    }
  });

  racine.addEventListener("submit", (evenement) => {
    evenement.preventDefault();
    if (evenement.target.id === "formulaire-estimation") lancer();
  });

  // Recalcul immediat quand on coche/decoche l'ajustement terrain
  racine.addEventListener("change", (evenement) => {
    if (evenement.target.id === "ajuster-terrain" && dernierResultat) lancer();
  });
}

function lireFormulaire() {
  const valeur = (id) => {
    const champ = racineElement.querySelector("#" + id);
    if (!champ || champ.value === "") return null;
    const n = Number(champ.value);
    return isFinite(n) ? n : null;
  };
  const ajuster = racineElement.querySelector("#ajuster-terrain");
  return {
    surface: valeur("surface-habitable"),
    terrain: valeur("surface-terrain"),
    pieces: valeur("nombre-pieces"),
    ajusterTerrain: Boolean(ajuster && ajuster.checked),
  };
}

// Bornes du formulaire, en un seul endroit. Elles doivent rester d'accord avec
// les attributs min/max des champs -- un test le verifie, en lisant le HTML
// produit plutot qu'en recopiant les chiffres.
const BORNES = {
  surface: { min: 15, max: 600, obligatoire: true,
             message: "Indiquez une surface habitable comprise entre 15 et 600 m²." },
  terrain: { min: 0, max: 100000, obligatoire: false,
             message: "La surface du terrain doit être comprise entre 0 et 100 000 m²." },
  pieces: { min: 1, max: 20, obligatoire: false,
            message: "Le nombre de pièces doit être compris entre 1 et 20." },
};

/**
 * Valide TOUT le formulaire, quel que soit le chemin emprunte.
 *
 * Le bouton « Estimer » passait par le submit, donc par la validation native du
 * navigateur ; la case « ajuster le terrain » appelle lancer() directement et la
 * contournait. Un terrain a -500 suivi d'un clic sur la case relancait le calcul
 * avec cette valeur. La validation vit donc ici, sur le seul chemin commun.
 *
 * checkValidity() ne suffit pas : il ne voit rien d'une valeur posee par
 * programme, ni d'un champ desactive. Les bornes sont donc revérifiées.
 */
function valider(parametres) {
  const formulaire = racineElement.querySelector("#formulaire-estimation");
  if (formulaire && !formulaire.checkValidity()) {
    formulaire.reportValidity();
    // On EFFACE aussi le resultat precedent. Laisser affiche un montant qui ne
    // correspond plus aux valeurs saisies serait trompeur -- pour un avis de
    // valeur, c'est le genre de chiffre qu'on recopie sans regarder l'entree.
    afficherErreur("Corrigez les valeurs signalées avant de relancer l'estimation.");
    return false;
  }
  for (const [nom, borne] of Object.entries(BORNES)) {
    const valeur = parametres[nom];
    if (valeur === null || valeur === undefined) {
      if (borne.obligatoire) {
        afficherErreur(borne.message);
        return false;
      }
      continue;
    }
    if (!isFinite(valeur) || valeur < borne.min || valeur > borne.max) {
      afficherErreur(borne.message);
      return false;
    }
  }
  return true;
}

function lancer() {
  const parametres = lireFormulaire();
  if (!valider(parametres)) return;
  actionsElement.estimer(parametres);
}

function afficherErreur(message) {
  const zone = racineElement.querySelector("#resultat-estimation");
  if (zone) zone.innerHTML = `<p class="erreur">${echapper(message)}</p>`;
}

function copierSynthese() {
  if (!dernierResultat || !dernierResultat.texte) return;
  navigator.clipboard.writeText(dernierResultat.texte).then(() => {
    const bouton = racineElement.querySelector("#copier-synthese");
    const ancien = bouton.textContent;
    bouton.textContent = "Copié ✓";
    setTimeout(() => { bouton.textContent = ancien; }, 1800);
  }).catch(() => afficherErreur("La copie automatique a échoué : sélectionnez le texte à la main."));
}

/**
 * Texte prêt à coller dans un avis de valeur.
 *
 * Volontairement NON échappé : cette chaîne part dans le presse-papier
 * (clipboard.writeText), pas dans la page. L'échapper collerait « &#39; » à la
 * place des apostrophes dans le document de l'utilisateur.
 */
function construireSynthese(commune, parametres, resultat, meta) {
  const lignes = [
    `Estimation indicative — ${commune.nom} (${commune.code})`,
    `Maison de ${parametres.surface} m² habitables`
      + (parametres.terrain ? `, terrain ${parametres.terrain} m²` : "")
      + (parametres.pieces ? `, ${parametres.pieces} pièces` : ""),
    "",
  ];
  if (resultat.valeur === null) {
    lignes.push("Données insuffisantes pour avancer une valeur.");
  } else {
    lignes.push(`Valeur estimée : ${euros(resultat.valeur)}`);
    lignes.push(`${REGLAGES.COUVERTURE_ANNONCEE}, le prix réel est entre `
      + `${euros(resultat.fourchette[0])} et ${euros(resultat.fourchette[1])}`);
    lignes.push(`Prix au m² retenu : ${eurosParM2(Math.round(resultat.prixM2Median))}`);
    lignes.push(`Dispersion locale : ${eurosParM2(Math.round(resultat.prixM2Q1))}`
      + ` à ${eurosParM2(Math.round(resultat.prixM2Q3))}`);
    lignes.push(`Amplitude : ${amplitudeEnTexte(resultat)} autour de l'estimation`
      + ` (calcul appuyé sur les ${LIBELLES_PALIER[resultat.palier]})`);
    if (resultat.palier === 1) {
      lignes.push(`Dont ${resultat.nMemeCommune} vente(s) dans la commune même.`);
    }
  }
  lignes.push("", `Source : DVF (ventes réelles enregistrées), millésimes `
    + `${(meta.millesimes || []).join(", ")}.`,
    "Estimation statistique : elle ignore l'état, les travaux et la vue du bien.");
  return lignes.join("\n");
}

function blocResultat(etat) {
  if (etat.estimationEnCours) {
    return `<p class="chargement">Recherche des ventes comparables…</p>`;
  }

  if (etat.erreurEstimation) {
    // Une panne de téléchargement n'est pas une absence de ventes : on le dit,
    // plutôt que d'afficher une estimation calculée sur des données partielles.
    return `<div class="resultat refus">
      <p class="refus-titre">Les ventes de cette commune n'ont pas pu être téléchargées.</p>
      <p>Vérifiez votre connexion, puis appuyez de nouveau sur « Estimer ».</p>
      <p class="detail">${echapper(etat.erreurEstimation)}</p>
    </div>`;
  }

  const resultat = etat.estimation;
  if (!resultat) return "";

  // Deuxième barrière contre l'affichage croisé : un résultat porte le code de
  // la commune pour laquelle il a été calculé. S'il ne correspond pas à la
  // commune affichée, on n'affiche RIEN plutôt qu'un montant trompeur.
  if (resultat.code && resultat.code !== etat.communeSelectionnee) return "";

  // Seul le conseil est encore affiche : le niveau lui-meme a cede la place a
  // l'amplitude, qui dit la meme chose en chiffres.
  const [, explication] = LIBELLES_CONFIANCE[resultat.confiance];

  if (resultat.valeur === null) {
    return `<div class="resultat refus">
      <p class="refus-titre">Pas assez de ventes pour estimer ce bien.</p>
      <p>${explication}</p>
      <p class="detail">${resultat.nBrut} vente(s) comparable(s) trouvée(s) — il en faudrait
      au moins ${REGLAGES.SEUIL_REFUS} de vraiment proches. Élargissez la surface recherchée
      ou appuyez-vous sur les ventes affichées sur la carte.</p>
    </div>`;
  }

  const ajustement = resultat.ajustementTerrain
    ? `<p class="detail">dont ajustement terrain : ${resultat.ajustementTerrain > 0 ? "+" : ""}${euros(resultat.ajustementTerrain)}</p>`
    : "";

  // Une FICHE par vente, et non plus un tableau a six colonnes.
  //
  // Mesure qui a motive le changement : le panneau fait 400 px de large, fixes.
  // Le tableau ne disposait donc que de 363 px pour six colonnes -- 57 px pour le
  // prix. « 493 400 € » se coupait en deux lignes, « 3 710 €/m² actualisé » en
  // trois, et le lien « carte » tombait a 27 x 14 px, quatre fois moins que les
  // 44 px recommandes pour un doigt. Le telephone n'y etait pour rien : la
  // mesure donne 363 px sur ordinateur contre 354 px sur telephone.
  //
  // L'alignement vertical des chiffres, seul avantage reel du tableau, est
  // conserve : toutes les fiches ont la meme structure, donc les prix et les
  // €/m² restent les uns sous les autres.
  const comparables = resultat.comparables.length ? `
    <h3>Ventes les plus comparables</h3>
    <p class="detail">« Street View » ouvre Google Maps à l'adresse de la vente.
      Toutes les voies n'y sont pas photographiées&nbsp;: chemins ruraux et
      lotissements privés y échappent souvent.</p>
    <ul class="comparables">${resultat.comparables.map((c, i) => `
      <li>
        <p class="cmp-entete">
          <span>${moisEnTexte(c.t, etat.meta.annee_origine)}${c.voisine
            ? ' <em class="voisine">commune voisine</em>' : ""}</span>
          <span class="etoiles" title="pertinence relative">${etoiles(
            c.poids / resultat.comparables[0].poids)}</span>
        </p>
        <p class="cmp-chiffres">
          <strong>${euros(c.prix)}</strong>
          <span class="cmp-m2">${eurosParM2(Math.round(c.prixM2))}<em>actualisé</em></span>
        </p>
        <p class="cmp-bien">${surface(c.sbati)}${c.sterr
          ? ` · terrain ${nombre(c.sterr)} m²` : ""}</p>
        ${c.adresse ? `<p class="cmp-adresse">${lienGoogleMaps(c.lat, c.lon)
          ? `<a href="${echapper(lienGoogleMaps(c.lat, c.lon))}" target="_blank"
               rel="noopener noreferrer">${echapper(adresseLisible(c.adresse))}</a>`
          : echapper(adresseLisible(c.adresse))}</p>` : ""}
        <p class="cmp-actions">
          <button type="button" class="cmp-action" data-comparable="${i}">Voir sur la carte</button>
          ${lienStreetView(c.lat, c.lon) ? `<a class="cmp-action"
            href="${echapper(lienStreetView(c.lat, c.lon))}"
            target="_blank" rel="noopener noreferrer">Street View</a>` : ""}
        </p>
      </li>`).join("")}</ul>` : "";

  return `<div class="resultat">
    <p class="valeur-principale">${euros(resultat.valeur)}</p>
    <p class="fourchette"><strong>${REGLAGES.COUVERTURE_ANNONCEE}</strong>, le prix réel
       est entre ${euros(resultat.fourchette[0])} et ${euros(resultat.fourchette[1])}</p>
    <p class="fourchette-note">Ce n'est pas une marge d'erreur théorique&nbsp;: c'est la
       fréquence relevée en rejouant l'estimation sur des dizaines de milliers de ventes
       passées.</p>
    ${ajustement}
    <p class="confiance confiance-${resultat.confiance}">
      Amplitude&nbsp;: <strong>${amplitudeEnTexte(resultat)}</strong> autour de
      l'estimation — ${explication}
    </p>
    <ul class="details-calcul">
      <li>Prix au m² retenu&nbsp;: <strong>${eurosParM2(Math.round(resultat.prixM2Median))}</strong></li>
      <li>Dispersion du marché local&nbsp;: ${eurosParM2(Math.round(resultat.prixM2Q1))}
          à ${eurosParM2(Math.round(resultat.prixM2Q3))}
          <em>(hétérogénéité des biens, à ne pas confondre avec la fourchette ci-dessus)</em></li>
      <li>Calculé sur ${resultat.nBrut} vente(s), soit ${Math.round(resultat.nEffectif)}
          équivalent(s) plein(s) — ${LIBELLES_PALIER[resultat.palier]}</li>
      ${resultat.palier === 1 ? `<li><strong>${resultat.nMemeCommune}</strong> de ces ventes
          seulement sont dans la commune même
          ${resultat.nMemeCommune < REGLAGES.MIN_VENTES_COMMUNE_PROPRE ? "<em>— l'estimation repose donc surtout sur les communes voisines</em>" : ""}</li>` : ""}
    </ul>
    <button type="button" id="copier-synthese" class="bouton-secondaire">Copier la synthèse</button>
    <p class="avertissement">DVF ne connaît ni l'état du bien, ni les travaux, ni la vue.
      Une maison rénovée et une passoire thermique de même surface y figurent au même titre.
      Ce chiffre est une aide à la décision, pas un avis de valeur signé.</p>
    ${comparables}
  </div>`;
}

export function rendre(etat) {
  if (!racineElement) return;

  if (!etat.communeSelectionnee) {
    racineElement.hidden = true;
    racineElement.innerHTML = "";
    dernierResultat = null;
    derniereEmpreinte = null;
    return;
  }
  racineElement.hidden = false;

  const empreinte = [etat.communeSelectionnee, etat.estimationEnCours,
    etat.erreurEstimation,
    etat.estimation ? etat.estimation.horodatage : null].join("\u0001");
  if (empreinte === derniereEmpreinte) return;
  derniereEmpreinte = empreinte;

  const commune = etat.communes.find((c) => c.code === etat.communeSelectionnee);
  if (!commune) return;

  dernierResultat = etat.estimation;
  if (dernierResultat && dernierResultat.valeur !== undefined) {
    dernierResultat.texte = construireSynthese(
      commune, etat.parametresEstimation || {}, dernierResultat, etat.meta,
    );
  }

  const anciennes = lireFormulaire();
  const statistiques = commune.m2_med === null
    ? `<p class="sans-donnees">Moins de ${etat.meta.min_ventes_affichage} ventes de maison
       enregistrées ici sur la période : aucune statistique fiable n'est calculable.</p>`
    : `<dl class="stats-commune">
        <div><dt>Prix médian au m²</dt><dd>${eurosParM2(commune.m2_med)}</dd></div>
        <div><dt>Moitié des ventes entre</dt><dd>${eurosParM2(commune.m2_q1)} et ${eurosParM2(commune.m2_q3)}</dd></div>
        <div><dt>Prix médian</dt><dd>${euros(commune.prix_med)}</dd></div>
        <div><dt>Surface médiane</dt><dd>${surface(commune.surf_med)}</dd></div>
        <div><dt>Terrain médian</dt><dd>${surface(commune.terr_med)}</dd></div>
        <div><dt>Ventes analysées</dt><dd>${nombre(commune.n)}</dd></div>
      </dl>`;

  racineElement.innerHTML = `
    <header class="entete-panneau">
      <div>
        <h2>${echapper(commune.nom)}</h2>
        <p class="sous-titre">${echapper(etat.meta.departements[commune.dep].nom)} · ${echapper(commune.code)}</p>
      </div>
      <button type="button" id="fermer-panneau" aria-label="Fermer">×</button>
    </header>
    ${statistiques}
    <h3>Estimer une maison ici</h3>
    <form id="formulaire-estimation">
      <div class="champs">
        <label>Surface habitable
          <input type="number" id="surface-habitable" min="15" max="600" step="1"
                 required placeholder="120" value="${anciennes.surface ?? ""}"> m²
        </label>
        <label>Terrain
          <input type="number" id="surface-terrain" min="0" max="100000" step="10"
                 placeholder="600" value="${anciennes.terrain ?? ""}"> m²
        </label>
        <label>Pièces
          <input type="number" id="nombre-pieces" min="1" max="20" step="1"
                 placeholder="5" value="${anciennes.pieces ?? ""}">
        </label>
      </div>
      ${commune.prix_terrain === null ? `
      <p class="case sans-donnees">Dans ce département, la taille du terrain
        n'explique pas le prix : les grands terrains y sont dans l'arrière-pays,
        moins cher, tandis que la prime va au littoral sur de petites parcelles.
        Aucun ajustement terrain n'est donc proposé ici.</p>` : `
      <label class="case"><input type="checkbox" id="ajuster-terrain"
        ${anciennes.ajusterTerrain ? "checked" : ""}>
        Ajuster selon la taille du terrain <em>(indicatif — le terrain est déjà
        partiellement pris en compte)</em></label>`}
      <button type="submit" class="bouton-principal">Estimer</button>
    </form>
    <div id="resultat-estimation">${blocResultat(etat)}</div>
  `;
}
