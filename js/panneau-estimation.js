// Panneau de droite : fiche de la commune + estimateur + ventes comparables.

import { echapper, euros, eurosParM2, etoiles, moisEnTexte, nombre, surface } from "./format.js";

let racineElement = null;
let actionsElement = null;
let dernierResultat = null;
// Meme precaution que pour la liste : sans cela, un simple deplacement de la
// carte reconstruirait le formulaire et ferait perdre le curseur a l'utilisateur
// en pleine saisie.
let derniereEmpreinte = null;

const LIBELLES_CONFIANCE = {
  bonne: ["Bonne", "Beaucoup de ventes très comparables dans la commune même."],
  moyenne: ["Moyenne", "Assez de ventes comparables, mais moins nombreuses ou moins proches."],
  faible: ["Faible", "Peu de comparables dans la commune même : à confronter impérativement avec votre connaissance du terrain."],
  insuffisante: ["Insuffisante", "Pas assez de ventes pour avancer un chiffre honnêtement."],
};

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

function lancer() {
  const parametres = lireFormulaire();
  if (!parametres.surface || parametres.surface < 15 || parametres.surface > 600) {
    afficherErreur("Indiquez une surface habitable comprise entre 15 et 600 m².");
    return;
  }
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
    lignes.push(`Fourchette : ${euros(resultat.fourchette[0])} à ${euros(resultat.fourchette[1])}`);
    lignes.push(`Prix au m² retenu : ${eurosParM2(Math.round(resultat.prixM2Median))}`);
    lignes.push(`Dispersion locale : ${eurosParM2(Math.round(resultat.prixM2Q1))}`
      + ` à ${eurosParM2(Math.round(resultat.prixM2Q3))}`);
    lignes.push(`Fiabilité : ${LIBELLES_CONFIANCE[resultat.confiance][0].toLowerCase()}`
      + ` (${Math.round(resultat.nEffectif)} ventes comparables retenues,`
      + ` ${LIBELLES_PALIER[resultat.palier]})`);
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

  const [titre, explication] = LIBELLES_CONFIANCE[resultat.confiance];

  if (resultat.valeur === null) {
    return `<div class="resultat refus">
      <p class="refus-titre">Pas assez de ventes pour estimer ce bien.</p>
      <p>${explication}</p>
      <p class="detail">${resultat.nBrut} vente(s) comparable(s) trouvée(s) — il en faudrait
      au moins ${Math.ceil(6)} de vraiment proches. Élargissez la surface recherchée
      ou appuyez-vous sur les ventes affichées sur la carte.</p>
    </div>`;
  }

  const ajustement = resultat.ajustementTerrain
    ? `<p class="detail">dont ajustement terrain : ${resultat.ajustementTerrain > 0 ? "+" : ""}${euros(resultat.ajustementTerrain)}</p>`
    : "";

  const comparables = resultat.comparables.length ? `
    <h3>Ventes les plus comparables</h3>
    <table class="comparables">
      <thead><tr><th>Vendue</th><th>Surface</th><th>Prix</th><th>€/m²</th><th>Proximité</th><th></th></tr></thead>
      <tbody>${resultat.comparables.map((c, i) => `
        <tr>
          <td>${moisEnTexte(c.t, etat.meta.annee_origine)}${c.voisine ? '<em class="voisine">commune voisine</em>' : ""}</td>
          <td>${surface(c.sbati)}${c.sterr ? `<em>${nombre(c.sterr)} m² terrain</em>` : ""}</td>
          <td>${euros(c.prix)}</td>
          <td>${eurosParM2(Math.round(c.prixM2))}<em>actualisé</em></td>
          <td class="etoiles" title="pertinence relative">${etoiles(c.poids / resultat.comparables[0].poids)}</td>
          <td><button type="button" class="lien" data-comparable="${i}">carte</button></td>
        </tr>`).join("")}</tbody>
    </table>` : "";

  return `<div class="resultat">
    <p class="valeur-principale">${euros(resultat.valeur)}</p>
    <p class="fourchette">fourchette&nbsp;: ${euros(resultat.fourchette[0])}
       – ${euros(resultat.fourchette[1])}</p>
    ${ajustement}
    <p class="confiance confiance-${resultat.confiance}">
      Fiabilité&nbsp;: <strong>${titre}</strong> — ${explication}
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
          ${resultat.nMemeCommune < 5 ? "<em>— l'estimation repose donc surtout sur les communes voisines</em>" : ""}</li>` : ""}
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
