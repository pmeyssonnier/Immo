// Chef d'orchestre de l'application.
//
// Regle de construction : aucun module n'en importe un autre. Seul ce fichier
// les connait tous. Les donnees circulent dans un seul sens :
//     evenement utilisateur -> action -> majEtat() -> rendre() de chaque module
// C'est ce qui rend le code relisible : pour comprendre ce qui se passe, il
// suffit de suivre les actions ci-dessous.

import { CONFIG } from "./config.js";
import { echapper } from "./format.js";
import { chargerAdjacence, chargerBandes, chargerBase, chargerVentes, chargerVoies }
  from "./donnees.js";
import { chercherVentes, indexerVoies, ressembleAUneAdresse } from "./adresses.js";
import { creerSuiviDeDemandes } from "./demandes.js";
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
  // L'annuaire des voies, charge a la demande : voir assurerAnnuaireDesVoies.
  annuaireVoies: null,
  annuaireEnCours: false,
  erreurAnnuaire: null,
  communeSelectionnee: null,
  zoom: CONFIG.ZOOM_INITIAL,
  bbox: null,

  ventesParCommune: {},
  estimation: null,
  estimationEnCours: false,
  parametresEstimation: null,
  erreurEstimation: null,      // panne pendant une estimation
  erreurDonnees: null,         // panne pendant le chargement de la carte
};

// Un seul suivi pour toute l'application : une commune choisie perime
// l'estimation en cours, et reciproquement.
const demandes = creerSuiviDeDemandes();

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

  // Numero de cette demande. Apres CHAQUE attente on verifiera qu'aucune
  // demande plus recente n'est partie : sans cela, une estimation lente pour
  // Nimes viendrait s'afficher sous le titre d'Uzes.
  const jeton = demandes.nouvelle();
  majEtat({
    estimationEnCours: true, estimation: null, erreurEstimation: null,
    parametresEstimation: parametres,
  });

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

  try {
    // --- palier 0 ---------------------------------------------------------
    // Si le telechargement echoue vraiment, il leve : on saute directement au
    // catch. C'est voulu. Une panne de reseau n'est PAS une absence de ventes,
    // on ne se rabat donc ni sur les communes voisines ni sur le departement.
    await assurerVentes([code]);
    if (!demandes.estLaDerniere(jeton)) return;

    const ventesCommune = (etat.ventesParCommune[code] || [])
      .map((v) => ({ ...v, voisine: false }));
    let resultat = estimer({ ...commun, ventes: ventesCommune, palier: 0 });

    // --- palier 1 ---------------------------------------------------------
    if (!resultat.suffisant) {
      const adjacence = await assurerAdjacence();
      if (!demandes.estLaDerniere(jeton)) return;

      const voisines = adjacence[code] || [];
      if (voisines.length) {
        await assurerVentes(voisines);
        if (!demandes.estLaDerniere(jeton)) return;

        const ventesVoisines = voisines.flatMap(
          (autre) => (etat.ventesParCommune[autre] || []).map((v) => ({ ...v, voisine: true })),
        );
        const elargi = estimer({
          ...commun, ventes: ventesCommune.concat(ventesVoisines), palier: 1,
        });
        if (elargi.nEffectif > resultat.nEffectif) resultat = elargi;
      }
    }

    // --- palier 2 ---------------------------------------------------------
    if (resultat.valeur === null) {
      const bandes = await assurerBandes(commune.dep);
      if (!demandes.estLaDerniere(jeton)) return;

      const repli = estimerParBandes({ bandes, surface: parametres.surface });
      if (repli.valeur !== null) resultat = repli;
    }

    if (!demandes.estLaDerniere(jeton)) return;
    // Le resultat porte le code de sa commune : le panneau refusera de
    // l'afficher sous une autre. Deuxieme barriere, apres le numero de demande.
    majEtat({
      estimation: { ...resultat, code, horodatage: Date.now() },
      estimationEnCours: false,
    });
  } catch (erreur) {
    if (!demandes.estLaDerniere(jeton)) return;
    majEtat({
      estimationEnCours: false, estimation: null,
      erreurEstimation: erreur && erreur.message ? erreur.message : String(erreur),
    });
  }
}

// --------------------------------------------------------------------------
// Les actions declenchees par l'interface
// --------------------------------------------------------------------------
let commandesCarte = null;

/**
 * Telecharge l'annuaire des voies, mais seulement s'il va servir.
 *
 * Il pese 0,8 Mo : le charger au demarrage doublerait le poids du site pour
 * une fonction dont on ne se sert pas a chaque visite. On attend donc que la
 * saisie ressemble a une adresse -- un numero de voirie en tete, ou un mot
 * comme « rue », « chemin », « impasse ». Une fois charge, il reste en memoire.
 *
 * Volontairement SANS numero de demande : cette fonction ne fait qu'ajouter
 * une donnee de reference a l'etat, elle n'affiche rien qui puisse se retrouver
 * sous le mauvais titre.
 */
async function assurerAnnuaireDesVoies(texte) {
  if (etat.annuaireVoies || etat.annuaireEnCours) return;
  if (!ressembleAUneAdresse(texte)) return;
  // Si la commune ouverte repond deja, il n'y a rien a telecharger : ses
  // ventes sont la. On ne paie l'annuaire que lorsqu'il sert vraiment.
  if (etat.communeSelectionnee) {
    const ventes = etat.ventesParCommune[etat.communeSelectionnee];
    const ouverte = etat.communes.find((c) => c.code === etat.communeSelectionnee);
    if (ventes && chercherVentes(ventes, texte, 1, ouverte && ouverte.nom).length) return;
  }
  majEtat({ annuaireEnCours: true, erreurAnnuaire: null });
  try {
    const table = await chargerVoies();
    majEtat({ annuaireVoies: indexerVoies(table), annuaireEnCours: false });
  } catch (erreur) {
    // Une panne ici ne doit pas passer pour « cette adresse n'existe pas ».
    majEtat({ annuaireEnCours: false, erreurAnnuaire: erreur.message });
  }
}

const actions = {
  changerRecherche(texte) {
    majEtat({ recherche: texte });
    assurerAnnuaireDesVoies(texte);
  },

  async selectionnerCommune(code) {
    // Recliquer la commune DEJA ouverte ne doit rien faire. Sans ce garde-fou,
    // un clic manque a cote d'un point de vente -- le geste le plus courant au
    // doigt -- remettait estimation a null et recentrait la carte sur le
    // chef-lieu : on perdait a la fois le quartier qu'on regardait et le
    // chiffre qu'on venait de calculer. Le panneau montre deja cette commune,
    // il n'y a rien a refaire.
    if (code === etat.communeSelectionnee) return;
    const commune = etat.communes.find((c) => c.code === code);
    const jeton = demandes.nouvelle();
    majEtat({
      communeSelectionnee: code, estimation: null, estimationEnCours: false,
      erreurEstimation: null,
    });

    // Le recentrage n'a pas besoin des ventes : on le fait AVANT l'attente.
    // La carte reagit donc immediatement, et surtout plus aucune variable
    // capturee ne sert apres l'attente -- la commune A ne peut plus voler la
    // vue a la commune B choisie entre-temps.
    if (commune && commune.lat !== null && commandesCarte) {
      commandesCarte.centrerSur(commune.lat, commune.lon, Math.max(etat.zoom, 12));
    }

    try {
      await assurerVentes([code]);
      if (!demandes.estLaDerniere(jeton)) return;
      majEtat({});
    } catch (erreur) {
      if (!demandes.estLaDerniere(jeton)) return;
      majEtat({ erreurDonnees: erreur.message });
    }
  },

  fermer() {
    // Fermer le panneau perime la demande en cours : un resultat qui arriverait
    // apres ne doit pas etre enregistre. Et estimationEnCours doit repasser a
    // false ici -- c'etait le seul chemin qui pouvait laisser
    // « Recherche des comparables... » tourner sans fin.
    demandes.nouvelle();
    majEtat({
      communeSelectionnee: null, estimation: null,
      estimationEnCours: false, erreurEstimation: null,
    });
  },

  // Volontairement SANS numero de demande : cette action ne capture aucune
  // variable avant son attente et se contente de repeindre depuis l'etat
  // courant, ce qui est toujours juste. Lui en donner un annulerait une
  // estimation legitime des que l'utilisateur deplace la carte.
  async majVue({ zoom, bbox }) {
    majEtat({ zoom, bbox });
    // en mode "ventes" sans commune choisie, on precharge ce qui est a l'ecran
    if (!etat.communeSelectionnee && zoom >= CONFIG.ZOOM_BASCULE_VENTES && bbox) {
      const visibles = etat.communes.filter(
        (c) => c.lat !== null && c.n > 0 && bbox.contains([c.lat, c.lon]),
      );
      if (visibles.length && visibles.length <= CONFIG.MAX_COMMUNES_SIMULTANEES) {
        try {
          await assurerVentes(visibles.map((c) => c.code));
          majEtat({});
        } catch (erreur) {
          // La carte doit rester utilisable : on signale, on ne bloque pas.
          majEtat({ erreurDonnees: erreur.message });
        }
      }
    }
  },

  estimer(parametres) {
    lancerEstimation(parametres);
  },

  voirVente(vente) {
    if (commandesCarte && vente) commandesCarte.ouvrirVente(vente);
  },

  /** Clic sur une vente trouvee par son adresse, dans la liste de gauche. */
  voirVenteDeLaListe(code, indice) {
    const ventes = etat.ventesParCommune[code];
    if (ventes && ventes[indice] && commandesCarte) commandesCarte.ouvrirVente(ventes[indice]);
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
