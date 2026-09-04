// La carte (Leaflet).
//
// Deux modes d'affichage, qui ne sont JAMAIS stockes dans l'etat mais toujours
// deduits de lui -- impossible d'avoir deux modes contradictoires :
//   * dezoome  : les communes sont coloriees selon leur prix au m2
//   * zoome    : les communes passent en simple contour et les ventes
//                apparaissent une par une
//
// Le fond de plan (les tuiles OpenStreetMap) est un CONFORT. S'il ne se charge
// pas, les contours restent lisibles et l'application reste utilisable.

import { CONFIG, couleurPrix } from "./config.js";
import { echapper, euros, eurosParM2, moisEnTexte, nombre, surface } from "./format.js";

let carte = null;
let coucheCommunes = null;
let groupeMarqueurs = null;
let signatureAffichee = null;
let bandeau = null;
let avertissementFond = null;
let avertissementDonnees = null;
let communesParCode = new Map();
let seuilsCouleurs = [];
let anneeOrigine = 2020;

const STYLE_CHOROPLETHE = { weight: 0.5, color: "#ffffff", fillOpacity: 0.75 };
const STYLE_CONTOUR_SEUL = { weight: 1, color: "#8a8a8a", fillOpacity: 0.05 };

function afficherBandeau(texte) {
  if (!bandeau) return;
  bandeau.textContent = texte;
  bandeau.hidden = false;
}

function masquerBandeau() {
  if (bandeau) bandeau.hidden = true;
}

/** Le mode est deduit, jamais stocke. */
function modeVentes(etat) {
  return etat.communeSelectionnee !== null || etat.zoom >= CONFIG.ZOOM_BASCULE_VENTES;
}

function styleCommune(code, etat) {
  const commune = communesParCode.get(code);
  if (modeVentes(etat)) {
    const selectionnee = code === etat.communeSelectionnee;
    return {
      ...STYLE_CONTOUR_SEUL,
      weight: selectionnee ? 3 : 1,
      color: selectionnee ? "#1f4e79" : "#8a8a8a",
      fillOpacity: selectionnee ? 0.08 : 0.03,
    };
  }
  return {
    ...STYLE_CHOROPLETHE,
    fillColor: couleurPrix(commune ? commune.m2_med : null, seuilsCouleurs),
    weight: code === etat.communeSelectionnee ? 3 : 0.5,
    color: code === etat.communeSelectionnee ? "#1f4e79" : "#ffffff",
  };
}

function contenuPopup(vente) {
  const prixM2 = Math.round(vente.prix / vente.sbati);
  return `<div class="popup-vente">
    <strong>${euros(vente.prix)}</strong>
    <span class="popup-m2">${eurosParM2(prixM2)}</span>
    <dl>
      <dt>Vendue</dt><dd>${moisEnTexte(vente.t, anneeOrigine)}</dd>
      <dt>Surface</dt><dd>${surface(vente.sbati)}${vente.pieces ? " · " + vente.pieces + " pièces" : ""}</dd>
      <dt>Terrain</dt><dd>${vente.sterr ? surface(vente.sterr) : "aucun"}</dd>
      <dt>Adresse</dt><dd>${echapper(vente.adresse) || "non renseignée"}</dd>
    </dl>
  </div>`;
}

function legende() {
  const controle = L.control({ position: "bottomright" });
  controle.onAdd = () => {
    const boite = L.DomUtil.create("div", "legende");
    boite.innerHTML = "<strong>Prix médian au m²</strong>";
    const cases = CONFIG.COULEURS.map((couleur, i) => {
      const borneBasse = i === 0 ? null : seuilsCouleurs[i - 1];
      const borneHaute = i === CONFIG.COULEURS.length - 1 ? null : seuilsCouleurs[i];
      let texte;
      if (borneBasse === null) texte = "moins de " + nombre(borneHaute) + " €";
      else if (borneHaute === null) texte = nombre(borneBasse) + " € et plus";
      else texte = nombre(borneBasse) + " – " + nombre(borneHaute) + " €";
      return `<span><i style="background:${couleur}"></i>${texte}</span>`;
    }).join("");
    boite.innerHTML += `<div class="echelle">${cases}</div>
      <span class="gris"><i style="background:${CONFIG.COULEUR_SANS_DONNEES}"></i>
      moins de 5 ventes</span>`;
    L.DomEvent.disableClickPropagation(boite);
    return boite;
  };
  return controle;
}

export function initialiser(racine, actions) {
  racine.innerHTML = `<div id="carte"></div>
    <div id="avertissement-fond" class="avertissement-carte" hidden></div>
    <div id="avertissement-donnees" class="avertissement-carte avertissement-panne" hidden></div>
    <div id="bandeau-carte" hidden></div>`;
  bandeau = racine.querySelector("#bandeau-carte");
  avertissementFond = racine.querySelector("#avertissement-fond");
  avertissementDonnees = racine.querySelector("#avertissement-donnees");

  // preferCanvas : indispensable pour afficher des milliers de points sans ramer
  carte = L.map(racine.querySelector("#carte"), {
    center: CONFIG.CENTRE, zoom: CONFIG.ZOOM_INITIAL,
    minZoom: CONFIG.ZOOM_MIN, maxZoom: CONFIG.ZOOM_MAX,
    preferCanvas: true,
  });

  const fond = L.tileLayer(CONFIG.TUILES, {
    attribution: CONFIG.ATTRIBUTION, maxZoom: CONFIG.ZOOM_MAX,
  });
  let tuilesSignalees = false;
  fond.on("tileerror", () => {
    if (tuilesSignalees) return;
    tuilesSignalees = true;
    // Message PERSISTANT, dans son propre element : il ne doit pas etre efface
    // par les messages temporaires de navigation.
    avertissementFond.textContent = "Fond de carte indisponible — "
      + "les contours des communes restent affichés.";
    avertissementFond.hidden = false;
  });
  fond.addTo(carte);

  groupeMarqueurs = L.markerClusterGroup({
    chunkedLoading: true,          // evite de figer la page sur les grandes villes
    maxClusterRadius: 45,
    disableClusteringAtZoom: 16,
    spiderfyOnMaxZoom: true,
  });
  carte.addLayer(groupeMarqueurs);

  const signaler = () => actions.majVue({
    zoom: carte.getZoom(),
    bbox: carte.getBounds(),
  });
  carte.on("zoomend", signaler);
  carte.on("moveend", signaler);

  return {
    /**
     * Cadre la carte sur les departements reellement charges.
     * Ainsi, ajouter ou retirer un departement ne demande de retoucher aucun
     * reglage : la vue de depart s'ajuste toute seule aux donnees.
     */
    cadrerSurLesDonnees(communes) {
      const points = communes
        .filter((c) => c.lat !== null && c.lon !== null)
        .map((c) => [c.lat, c.lon]);
      if (points.length) {
        carte.fitBounds(L.latLngBounds(points), { padding: [18, 18] });
      }
    },

    centrerSur(lat, lon, zoom) {
      carte.setView([lat, lon], zoom || Math.max(carte.getZoom(), 14));
    },
    ouvrirVente(vente) {
      carte.setView([vente.lat, vente.lon], 17);
      L.popup({ closeButton: true })
        .setLatLng([vente.lat, vente.lon])
        .setContent(contenuPopup(vente))
        .openOn(carte);
    },
    invalider() { carte.invalidateSize(); },
  };
}

/** Construit la couche des communes UNE SEULE FOIS (ensuite on change le style). */
function creerCoucheCommunes(etat, actions) {
  coucheCommunes = L.geoJSON(etat.contours, {
    style: (entite) => styleCommune(entite.properties.code, etat),
    onEachFeature: (entite, couche) => {
      const code = entite.properties.code;
      const commune = communesParCode.get(code);
      couche.bindTooltip(
        commune
          ? `<strong>${echapper(commune.nom)}</strong><br>${commune.m2_med === null
            ? "données insuffisantes" : eurosParM2(commune.m2_med)}`
          : code,
        { sticky: true },
      );
      couche.on("click", () => actions.selectionnerCommune(code));
    },
  }).addTo(carte);
  legende().addTo(carte);
}

function communesAMontrer(etat) {
  // Une commune selectionnee : on montre ses ventes et celles de personne d'autre.
  if (etat.communeSelectionnee) return [etat.communeSelectionnee];
  if (etat.zoom < CONFIG.ZOOM_BASCULE_VENTES || !etat.bbox) return [];

  const visibles = etat.communes.filter(
    (c) => c.lat !== null && c.n > 0 && etat.bbox.contains([c.lat, c.lon]),
  );
  // Garde-fou : on ne declenche jamais des dizaines de telechargements d'un coup.
  if (visibles.length > CONFIG.MAX_COMMUNES_SIMULTANEES) return null;
  return visibles.map((c) => c.code);
}

export function rendre(etat, actions) {
  if (!carte || !etat.contours) return;

  communesParCode = new Map(etat.communes.map((c) => [c.code, c]));
  seuilsCouleurs = etat.meta.seuils_couleurs || [];
  anneeOrigine = etat.meta.annee_origine || 2020;

  // Une couche de points incomplète ne doit jamais passer pour complète.
  if (avertissementDonnees) {
    avertissementDonnees.textContent = etat.erreurDonnees
      ? "Certaines ventes n'ont pas pu être téléchargées — la carte est incomplète."
      : "";
    avertissementDonnees.hidden = !etat.erreurDonnees;
  }

  if (!coucheCommunes) creerCoucheCommunes(etat, actions);
  // On ne reconstruit pas la couche : on se contente de changer son style.
  coucheCommunes.setStyle((entite) => styleCommune(entite.properties.code, etat));

  const souhaitees = communesAMontrer(etat);
  if (souhaitees === null) {
    afficherBandeau("Trop de communes à l'écran — zoomez davantage ou choisissez "
      + "une commune dans la liste pour voir les ventes.");
    if (signatureAffichee !== null) { groupeMarqueurs.clearLayers(); signatureAffichee = null; }
    return;
  }
  masquerBandeau();

  // La signature inclut le NOMBRE de ventes deja chargees pour chaque commune :
  // ainsi, quand les ventes arrivent apres coup, la couche est bien reconstruite.
  const signature = souhaitees.slice().sort()
    .map((code) => code + ":" + ((etat.ventesParCommune[code] || []).length))
    .join("|");
  if (signature === signatureAffichee) return;

  groupeMarqueurs.clearLayers();
  signatureAffichee = signature;

  const marqueurs = [];
  for (const code of souhaitees) {
    for (const vente of etat.ventesParCommune[code] || []) {
      if (vente.lat === null || vente.lon === null) continue;
      const marqueur = L.circleMarker([vente.lat, vente.lon], {
        radius: 5, weight: 1, color: "#5a3a10", opacity: 0.9,
        fillColor: couleurPrix(Math.round(vente.prix / vente.sbati), seuilsCouleurs),
        fillOpacity: 0.9,
      });
      // La popup n'est construite qu'au clic : sur Nimes cela evite de fabriquer
      // 3 000 blocs de HTML pour rien.
      marqueur.bindPopup(() => contenuPopup(vente));
      marqueurs.push(marqueur);
    }
  }
  groupeMarqueurs.addLayers(marqueurs);
}
