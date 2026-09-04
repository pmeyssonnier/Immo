// Chef d'orchestre de l'application.
//
// Regle de construction : aucun module n'en importe un autre. Seul ce fichier
// les connait tous. Les donnees circulent dans un seul sens :
//     evenement utilisateur -> action -> majEtat() -> rendre() de chaque module
// C'est ce qui rend le code relisible : pour comprendre ce qui se passe, il
// suffit de suivre les actions ci-dessous.

import { CONFIG } from "./config.js";
import { echapper } from "./format.js";
import { chargerAdjacence, chargerBandes, chargerBase, chargerVentes } from "./donnees.js";
import { estimer, estimerParBandes } from "./estimation.js";
import * as liste from "./liste.js";
import * as carte from "./carte.js";
import * as panneau from "./panneau-estimation.js";

// --------------------------------------------------------------------------
// L'etat : une seule source de verite
// --------------------------------------------------------------------------
const etat = {
  communes: [],
  meta: null,
  contours: null,
  adjacence: null,          // charge a la demande, voir assurerAdjacence
  bandesParDepartement: {},

  recherche: "",
  communeSelectionnee: null,
  zoom: CONFIG.ZOOM_INITIAL,
  bbox: null,

  ventesParCommune: {},
  estimation: null,
  estimationEnCours: false,
  parametresEstimation: null,
};

const abonnes = [];
function majEtat(modifications) {
  Object.assign(etat, modifications);
  abonnes.forEach((rendre) => rendre(etat));
}

// --------------------------------------------------------------------------
// Chargement des ventes (avec mise en cache dans l'etat)
// --------------------------------------------------------------------------
async function assurerVentes(codes) {
  const manquants = codes.filter((code) => !(code in etat.ventesParCommune));
  if (!manquants.length) return;
  const lots = await Promise.all(
    manquants.map((code) => chargerVentes(code, code.slice(0, 2))),
  );
  const ajout = {};
  manquants.forEach((code, i) => { ajout[code] = lots[i]; });
  etat.ventesParCommune = { ...etat.ventesParCommune, ...ajout };
}

async function assurerAdjacence() {
  if (!etat.adjacence) etat.adjacence = await chargerAdjacence();
  return etat.adjacence;
}

async function assurerBandes(departement) {
  if (etat.bandesParDepartement[departement]) return etat.bandesParDepartement[departement];
  const bandes = await chargerBandes(departement);
  etat.bandesParDepartement = { ...etat.bandesParDepartement, [departement]: bandes };
  return bandes;
}

// --------------------------------------------------------------------------
// L'estimation : elargissement par paliers
//   palier 0 : la commune seule
//   palier 1 : la commune + ses communes limitrophes
//   palier 2 : les moyennes du departement par tranche de surface
// On s'arrete des que l'on a assez de matiere -- ce qui plafonne le nombre de
// fichiers telecharges, quoi qu'il arrive.
// --------------------------------------------------------------------------
async function lancerEstimation(parametres) {
  const code = etat.communeSelectionnee;
  const commune = etat.communes.find((c) => c.code === code);
  if (!commune) return;

  majEtat({ estimationEnCours: true, estimation: null, parametresEstimation: parametres });

  const commun = {
    surface: parametres.surface,
    terrain: parametres.terrain,
    pieces: parametres.pieces,
    ajusterTerrain: parametres.ajusterTerrain,
    prixTerrain: commune.prix_terrain,
    tReference: etat.meta.mois_reference,
    anneeOrigine: etat.meta.annee_origine,
    indicesAnnuels: etat.meta.indice_prix[commune.dep] || {},
  };

  // --- palier 0 -----------------------------------------------------------
  await assurerVentes([code]);
  const ventesCommune = (etat.ventesParCommune[code] || [])
    .map((v) => ({ ...v, voisine: false }));
  let resultat = estimer({ ...commun, ventes: ventesCommune, palier: 0 });

  // --- palier 1 -----------------------------------------------------------
  if (!resultat.suffisant) {
    const voisines = (await assurerAdjacence())[code] || [];
    if (voisines.length) {
      await assurerVentes(voisines);
      const ventesVoisines = voisines.flatMap(
        (autre) => (etat.ventesParCommune[autre] || []).map((v) => ({ ...v, voisine: true })),
      );
      const elargi = estimer({
        ...commun, ventes: ventesCommune.concat(ventesVoisines), palier: 1,
      });
      if (elargi.nEffectif > resultat.nEffectif) resultat = elargi;
    }
  }

  // --- palier 2 -----------------------------------------------------------
  if (resultat.valeur === null) {
    try {
      const bandes = await assurerBandes(commune.dep);
      const repli = estimerParBandes({ bandes, surface: parametres.surface });
      if (repli.valeur !== null) resultat = repli;
    } catch (erreur) {
      // pas de table de repli : on garde le refus, c'est le comportement honnete
    }
  }

  // horodatage : permet au panneau de detecter un NOUVEAU resultat, meme si
  // les chiffres sont identiques au precedent.
  majEtat({ estimation: { ...resultat, horodatage: Date.now() }, estimationEnCours: false });
}

// --------------------------------------------------------------------------
// Les actions declenchees par l'interface
// --------------------------------------------------------------------------
let commandesCarte = null;

const actions = {
  changerRecherche(texte) {
    majEtat({ recherche: texte });
  },

  async selectionnerCommune(code) {
    const commune = etat.communes.find((c) => c.code === code);
    majEtat({
      communeSelectionnee: code, estimation: null, estimationEnCours: false,
    });
    await assurerVentes([code]);
    majEtat({});
    if (commune && commune.lat !== null && commandesCarte) {
      commandesCarte.centrerSur(commune.lat, commune.lon, Math.max(etat.zoom, 12));
    }
  },

  fermer() {
    majEtat({ communeSelectionnee: null, estimation: null });
  },

  async majVue({ zoom, bbox }) {
    majEtat({ zoom, bbox });
    // en mode "ventes" sans commune choisie, on precharge ce qui est a l'ecran
    if (!etat.communeSelectionnee && zoom >= CONFIG.ZOOM_BASCULE_VENTES && bbox) {
      const visibles = etat.communes.filter(
        (c) => c.lat !== null && c.n > 0 && bbox.contains([c.lat, c.lon]),
      );
      if (visibles.length && visibles.length <= CONFIG.MAX_COMMUNES_SIMULTANEES) {
        await assurerVentes(visibles.map((c) => c.code));
        majEtat({});
      }
    }
  },

  estimer(parametres) {
    lancerEstimation(parametres);
  },

  voirVente(vente) {
    if (commandesCarte && vente) commandesCarte.ouvrirVente(vente);
  },
};

// --------------------------------------------------------------------------
// Demarrage
// --------------------------------------------------------------------------
function afficherErreurFatale(erreur) {
  document.getElementById("chargement").innerHTML = `
    <div class="erreur-fatale">
      <h2>L'application n'a pas pu charger ses données</h2>
      <p><strong>${echapper(erreur.message)}</strong></p>
      <p>Si vous avez ouvert le fichier <code>index.html</code> par un double-clic,
      c'est normal : votre navigateur interdit à une page locale de lire des
      fichiers voisins (règle de sécurité, rien à voir avec l'application).</p>
      <p>Deux solutions&nbsp;:</p>
      <ul>
        <li>utiliser l'adresse du site en ligne&nbsp;;</li>
        <li>ou, sur votre ordinateur, ouvrir un terminal dans ce dossier et taper
        <code>python3 -m http.server 8000</code>, puis aller sur
        <code>http://localhost:8000</code>.</li>
      </ul>
    </div>`;
}

async function demarrer() {
  try {
    const base = await chargerBase();
    Object.assign(etat, base);

    if (base.meta.demonstration) {
      const bandeau = document.getElementById("bandeau-demo");
      bandeau.hidden = false;
    }
    document.getElementById("millesimes").textContent =
      (base.meta.millesimes || []).join(", ");
    document.getElementById("nb-ventes").textContent =
      new Intl.NumberFormat("fr-FR").format(base.meta.nb_ventes);

    liste.initialiser(document.getElementById("panneau-gauche"), actions);
    commandesCarte = carte.initialiser(document.getElementById("zone-carte"), actions);
    panneau.initialiser(document.getElementById("panneau-droit"), actions);

    abonnes.push(liste.rendre);
    abonnes.push((e) => carte.rendre(e, actions));
    abonnes.push(panneau.rendre);

    document.getElementById("chargement").hidden = true;
    document.getElementById("application").hidden = false;
    commandesCarte.invalider();
    commandesCarte.cadrerSurLesDonnees(etat.communes);
    majEtat({});
  } catch (erreur) {
    afficherErreurFatale(erreur);
  }
}

demarrer();
