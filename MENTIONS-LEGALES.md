# Mentions légales et sources

## Origine des données

Les ventes affichées proviennent des **Demandes de Valeurs Foncières (DVF)**,
publiées par la Direction générale des Finances publiques (DGFiP) et diffusées
en données ouvertes sur `data.gouv.fr`.

Ce site utilise la version **géolocalisée et normalisée** produite par Etalab :
<https://www.data.gouv.fr/datasets/demandes-de-valeurs-foncieres-geolocalisees>

Les contours des communes proviennent du projet *france-geojson*
(<https://github.com/gregoiredavid/france-geojson>), dérivé des données de l'IGN.

Le fond de plan est fourni par **OpenStreetMap** et ses contributeurs
(<https://www.openstreetmap.org/copyright>).

Le millésime exact des données utilisées est affiché en haut de chaque page et
enregistré dans `data/meta.json` (champs `millesimes` et `genere_le`).

## Licence des données

DVF est diffusé sous **Licence Ouverte / Open Licence** (Etalab). Sa réutilisation,
y compris commerciale, est autorisée, à condition de mentionner la source — ce que
fait ce site, en en-tête de page et dans le présent document.

## Nature des informations publiées

DVF ne contient **aucune donnée nominative** : ni le nom du vendeur, ni celui de
l'acquéreur n'y figurent. Les informations diffusées ici (adresse, prix, surface,
date) sont celles publiées par l'administration fiscale.

Les départements d'Alsace-Moselle (67, 68, 57) et Mayotte ne figurent pas dans DVF.
Cela est sans effet ici : aucun de ces territoires ne figure parmi les
11 départements couverts (Alpes-de-Haute-Provence (04), Hautes-Alpes (05), Alpes-Maritimes (06), Ardèche (07), Aude (11), Bouches-du-Rhône (13), Drôme (26), Gard (30), Hérault (34), Var (83), Vaucluse (84)).

## Portée des estimations

Les estimations produites par ce site sont des **calculs statistiques** fondés
uniquement sur les ventes enregistrées. Elles ne tiennent pas compte de l'état du
bien, des travaux réalisés, du diagnostic de performance énergétique, de
l'exposition, de la vue, des nuisances ni d'aucune caractéristique qualitative.

Elles constituent une **aide à la décision** et **ne valent pas avis de valeur,
expertise immobilière ni évaluation opposable**. Elles n'engagent pas leur auteur.

## Traitement appliqué aux données brutes

Les prix affichés ne sont pas repris tels quels : le script
`scripts/preparer_donnees.py` écarte les mutations qui ne sont pas des ventes
simples de maison (ventes mixtes, lots de copropriété, ventes couvrant plusieurs
biens ou plusieurs communes, VEFA), ainsi que les valeurs manifestement aberrantes.
Le détail des règles et le décompte des rejets figurent dans `data/_rapport.txt`.
