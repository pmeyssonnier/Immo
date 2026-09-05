#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Prepare les donnees de l'application "Immo Gard & Ardeche".

Ce script telecharge les ventes immobilieres publiees par l'Etat (DVF geolocalise),
les nettoie, puis fabrique les petits fichiers JSON que le site web lit.

Il n'utilise QUE la bibliotheque standard de Python : aucun "pip install" n'est
necessaire. Il tourne donc a l'identique sur GitHub Actions, dans Google Colab,
et sur un ordinateur personnel.

Utilisation :
    python scripts/preparer_donnees.py --annees 5 --sortie data
    python scripts/preparer_donnees.py --source-locale tests/fixtures --sortie /tmp/demo
    python scripts/preparer_donnees.py --verifier data
"""

import argparse
import csv
import datetime as dt
import gzip
import http.client
import io
import json
import math
import os
import random
import re
import shutil
import statistics
import sys
import tempfile
import time
import urllib.error
import urllib.request
from collections import defaultdict

# --------------------------------------------------------------------------
# Reglages generaux
# --------------------------------------------------------------------------

# Les departements couverts, dans l'ordre d'affichage. Le "slug" est le nom du
# dossier chez france-geojson, d'ou proviennent les contours des communes.
# Pour en ajouter un : une ligne ici, et rien d'autre a toucher.
DEPARTEMENTS = {
    "04": {"nom": "Alpes-de-Haute-Provence", "slug": "04-alpes-de-haute-provence"},
    "05": {"nom": "Hautes-Alpes", "slug": "05-hautes-alpes"},
    "06": {"nom": "Alpes-Maritimes", "slug": "06-alpes-maritimes"},
    "07": {"nom": "Ardèche", "slug": "07-ardeche"},
    "09": {"nom": "Ariège", "slug": "09-ariege"},
    "11": {"nom": "Aude", "slug": "11-aude"},
    "12": {"nom": "Aveyron", "slug": "12-aveyron"},
    "13": {"nom": "Bouches-du-Rhône", "slug": "13-bouches-du-rhone"},
    "26": {"nom": "Drôme", "slug": "26-drome"},
    "30": {"nom": "Gard", "slug": "30-gard"},
    "31": {"nom": "Haute-Garonne", "slug": "31-haute-garonne"},
    "32": {"nom": "Gers", "slug": "32-gers"},
    "34": {"nom": "Hérault", "slug": "34-herault"},
    "46": {"nom": "Lot", "slug": "46-lot"},
    "48": {"nom": "Lozère", "slug": "48-lozere"},
    "65": {"nom": "Hautes-Pyrénées", "slug": "65-hautes-pyrenees"},
    "66": {"nom": "Pyrénées-Orientales", "slug": "66-pyrenees-orientales"},
    "81": {"nom": "Tarn", "slug": "81-tarn"},
    "82": {"nom": "Tarn-et-Garonne", "slug": "82-tarn-et-garonne"},
    "83": {"nom": "Var", "slug": "83-var"},
    "84": {"nom": "Vaucluse", "slug": "84-vaucluse"},
}

URL_DVF = "https://files.data.gouv.fr/geo-dvf/latest/csv/{annee}/departements/{dep}.csv.gz"
URL_CONTOURS = {
    dep: "https://raw.githubusercontent.com/gregoiredavid/france-geojson/master/"
         "departements/{slug}/communes-{slug}.geojson".format(slug=infos["slug"])
    for dep, infos in DEPARTEMENTS.items()
}

# Les dates de vente sont stockees en "nombre de mois depuis janvier 2020".
# C'est compact (un entier entre 0 et ~90) et suffisant pour ponderer l'anciennete.
ANNEE_ORIGINE = 2020

# Colonnes DVF dont on a absolument besoin. Si l'une manque, le format a change
# et on prefere echouer bruyamment plutot que produire des chiffres faux.
COLONNES_REQUISES = [
    "id_mutation", "date_mutation", "nature_mutation", "valeur_fonciere",
    "code_commune", "nom_commune", "code_departement", "id_parcelle",
    "nombre_lots", "type_local", "surface_reelle_bati",
    "nombre_pieces_principales", "surface_terrain", "longitude", "latitude",
]
COLONNES_ADRESSE = ["adresse_numero", "adresse_suffixe", "adresse_nom_voie"]

# --- Etage 1 du nettoyage : bornes absolues de plausibilite -----------------
# Ces bornes ne servent qu'a ecarter les absurdites de saisie. Elles sont
# volontairement TRES larges : c'est le filtre MAD, calcule commune par commune,
# qui fait le vrai tri. Elles ont ete elargies en passant de 2 a 14 departements,
# car une villa du Cap d'Antibes a 20 000 EUR/m2 est une vente parfaitement
# reelle, la ou les anciennes bornes (calees sur le Gard) l'auraient supprimee
# et auraient donc fausse la mediane des communes du littoral vers le bas.
PRIX_MIN, PRIX_MAX = 10_000.0, 15_000_000.0
BATI_MIN, BATI_MAX = 15.0, 1_000.0
TERRAIN_MAX = 100_000.0
PRIX_M2_MIN, PRIX_M2_MAX = 200.0, 25_000.0
PIECES_MAX = 20

# --- Etage 2 : ecart median absolu (MAD) en espace logarithmique ------------
SEUIL_MAD = 3.0           # on garde si |ln(u) - mediane| <= 3 * sigma robuste
MIN_VENTES_MAD_COMMUNE = 8  # en dessous, on utilise le seuil departemental

# --- Carte : une commune avec trop peu de ventes n'est pas coloriee ---------
MIN_VENTES_AFFICHAGE = 5

# --- Simplification des contours -------------------------------------------
DECIMALES_CONTOURS = 4     # ~10 m, largement suffisant a l'echelle d'un departement
# ~160 m. Mesure faite sur 14 departements (avant l'ajout des 7 d'Occitanie) :
# a 160 m les contours pesaient
# 378 Ko compresses, a 240 m ils tomberaient a 303 Ko. L'ecart de trace atteint
# au pire 4 pixels au zoom 12 -- or a ce zoom les communes ne sont plus que des
# reperes en trait fin derriere les points de vente, et au zoom d'ensemble
# (le seul ou le coloriage compte) l'ecart est inferieur au pixel. Les 75 Ko
# gagnes a 240 m ne valent pas de doubler cet ecart.
EPSILON_DP = 0.002

# --- Bandes de surface pour le repli departemental de l'estimateur ---------
BANDES_SURFACE = [(0, 70), (70, 90), (90, 110), (110, 130),
                  (130, 160), (160, 200), (200, 601)]

# --- Prix marginal du terrain ----------------------------------------------
TERRAIN_PLAFOND_REGRESSION = 2500.0
# Plage de plausibilite d'un prix de terrain attenant, en EUR/m2. Une valeur qui
# en sort n'est pas "extreme" : elle signale que le terrain n'explique pas le
# prix dans ce departement. On ne publie alors AUCUN chiffre.
#
# La borne basse est un seuil de PERTINENCE, pas de plausibilite. L'ajustement
# est plafonne a 2 500 m2 d'ecart de terrain : a 3 EUR/m2, cela represente
# 7 500 EUR, soit environ 3 % d'une maison a 250 000 EUR -- moins que la
# fourchette minimale de +/-4 % que l'estimation s'impose deja. En dessous, le
# chiffre serait plus petit que sa propre marge d'erreur.
# Mesure a l'appui : la Haute-Garonne ressort a 0,85 EUR/m2, soit +2 100 EUR
# pour 2 500 m2 de terrain supplementaires. C'est du bruit, pas une mesure ;
# avec l'ancienne borne a 1,0 elle passait pourtant de justesse.
#
# La borne haute laisse de la marge au littoral : les Pyrenees-Orientales
# ressortent a 63 EUR/m2, ce qui est reel. Un plafond trop bas rejetterait a
# tort un departement cotier.
PRIX_TERRAIN_MIN, PRIX_TERRAIN_MAX = 3.0, 120.0
# Le prix du terrain est calcule au niveau du DEPARTEMENT, jamais par commune.
# Mesure faite sur des donnees simulees calibrees sur le reel : avec 600 ventes,
# l'estimation varie de 2 a 23 EUR/m2 selon l'echantillon (ecart-type 6,6) pour
# une vraie valeur de 25 -- inutilisable. Il faut plusieurs milliers de ventes
# pour se stabiliser. Aucune commune du Gard ni de l'Ardeche n'en a autant ;
# les departements, si (30 000 et 15 000). On s'en tient donc a leur valeur, qui
# se reproduit a +/- 0,5 EUR/m2 d'un tirage a l'autre.
MIN_VENTES_REGRESSION_TERRAIN = 2000
MAX_PAIRES_THEIL_SEN = 200000


# --------------------------------------------------------------------------
# Petits utilitaires
# --------------------------------------------------------------------------

def journal(message):
    """Affiche un message d'avancement (et le note pour le rapport final)."""
    print(message, flush=True)
    RAPPORT.append(message)


RAPPORT = []


def nombre(texte):
    """Convertit un champ CSV en nombre, ou None si vide/illisible."""
    if texte is None:
        return None
    texte = texte.strip()
    if not texte:
        return None
    try:
        return float(texte)
    except ValueError:
        return None


def entier(texte):
    valeur = nombre(texte)
    return None if valeur is None else int(valeur)


def mois_depuis_origine(date_texte):
    """'2024-03-17' -> nombre de mois ecoules depuis janvier 2020."""
    try:
        annee, mois = int(date_texte[0:4]), int(date_texte[5:7])
    except (ValueError, IndexError, TypeError):
        return None
    return (annee - ANNEE_ORIGINE) * 12 + (mois - 1)


def annee_depuis_mois(t):
    return ANNEE_ORIGINE + t // 12


def mediane(valeurs):
    return statistics.median(valeurs) if valeurs else None


def quantile(valeurs_triees, q):
    """Quantile par interpolation lineaire sur une liste DEJA triee."""
    if not valeurs_triees:
        return None
    if len(valeurs_triees) == 1:
        return valeurs_triees[0]
    position = q * (len(valeurs_triees) - 1)
    bas = int(math.floor(position))
    haut = min(bas + 1, len(valeurs_triees) - 1)
    poids = position - bas
    return valeurs_triees[bas] * (1 - poids) + valeurs_triees[haut] * poids


# --------------------------------------------------------------------------
# Telechargement
# --------------------------------------------------------------------------
# Un passage du robot enchaine 105 telechargements (21 departements x 5 annees),
# tous les mois. Le reseau finira par lacher sur l'un d'eux. Trois regles :
#   1. une panne se reessaie, une reponse claire du serveur ne se reessaie pas ;
#   2. un fichier incomplet n'est jamais confondu avec un fichier complet ;
#   3. si la matrice (annee x departement) n'est pas pleine, on ne publie rien.
# La regle 3 est la plus importante : des donnees anciennes mais completes valent
# mieux que des donnees fraiches et trouees. Une estimation faite sur une serie a
# laquelle il manque une annee reste credible ; elle est simplement fausse.

TENTATIVES_MAX = 3
ATTENTES_REESSAI = (5, 20)                      # secondes entre deux tentatives
CODES_SANS_REESSAI = (400, 401, 403, 404, 410)  # le serveur a repondu : insister ne sert a rien
ENTETES_HTTP = {"User-Agent": "immo-gard-ardeche/1.0"}
MIN_MILLESIMES = 3                              # en dessous, l'indice de prix ne vaut rien

# Les pannes reseau qu'il est normal de rencontrer. urllib.error.HTTPError et
# URLError descendent d'OSError ; http.client.HTTPException couvre les reponses
# tronquees. ValueError attrape un Content-Length illisible.
PANNES_RESEAU = (OSError, http.client.HTTPException, ValueError)


def attendre_avant_reessai(tentative):
    """Pause entre deux tentatives. Isolee pour que les tests la neutralisent."""
    if tentative - 1 < len(ATTENTES_REESSAI):
        time.sleep(ATTENTES_REESSAI[tentative - 1])


def supprimer_si_present(chemin):
    try:
        os.remove(chemin)
    except OSError:
        pass


def telecharger(url, destination):
    """Telecharge un fichier. Renvoie True si tout s'est bien passe.

    Le contenu est ecrit dans un fichier ".part" : le nom definitif n'apparait
    que si le transfert est alle jusqu'au bout ET que la taille annoncee par le
    serveur est respectee. Une coupure en fin de transfert laisse donc un fichier
    absent, jamais un fichier tronque qu'on prendrait pour complet.
    """
    partiel = destination + ".part"
    for tentative in range(1, TENTATIVES_MAX + 1):
        try:
            requete = urllib.request.Request(url, headers=ENTETES_HTTP)
            with urllib.request.urlopen(requete, timeout=180) as reponse, \
                    open(partiel, "wb") as sortie:
                ecrits = 0
                while True:
                    morceau = reponse.read(65536)
                    if not morceau:
                        break
                    sortie.write(morceau)
                    ecrits += len(morceau)
                annonce = reponse.headers.get("Content-Length")
            if annonce is not None and int(annonce) != ecrits:
                raise OSError("fichier tronque : %d octets recus sur %s annonces"
                              % (ecrits, annonce))
            os.replace(partiel, destination)
            return True
        except PANNES_RESEAU as erreur:
            supprimer_si_present(partiel)
            definitif = (isinstance(erreur, urllib.error.HTTPError)
                         and erreur.code in CODES_SANS_REESSAI)
            if definitif or tentative == TENTATIVES_MAX:
                journal("  ... indisponible (%s)" % erreur)
                return False
            journal("  ... echec (%s), nouvelle tentative %d/%d"
                    % (erreur, tentative + 1, TENTATIVES_MAX))
            attendre_avant_reessai(tentative)
    return False


def url_existe(url):
    """True, False, ou None quand on n'a pas pu savoir.

    La distinction compte : un 404 est une reponse (le millesime n'existe pas),
    une panne reseau n'en est pas une. Les confondre revient a publier une annee
    de moins sans que personne ne s'en apercoive.
    """
    for tentative in range(1, TENTATIVES_MAX + 1):
        try:
            requete = urllib.request.Request(url, method="HEAD", headers=ENTETES_HTTP)
            with urllib.request.urlopen(requete, timeout=60) as reponse:
                return reponse.status == 200
        except PANNES_RESEAU as erreur:
            if (isinstance(erreur, urllib.error.HTTPError)
                    and erreur.code in CODES_SANS_REESSAI):
                return False
            if tentative == TENTATIVES_MAX:
                journal("  ... etat de %s inconnu apres %d tentatives (%s)"
                        % (url, TENTATIVES_MAX, erreur))
                return None
            attendre_avant_reessai(tentative)
    return None


def millesimes_disponibles(nb_annees):
    """Trouve les N annees les plus recentes disponibles pour TOUS les departements.

    On ne code aucune annee en dur : le script reste valable dans 5 ans.
    """
    annee_courante = dt.date.today().year
    trouvees = []
    for annee in range(annee_courante, annee_courante - 8, -1):
        complet = True
        for dep in DEPARTEMENTS:
            etat = url_existe(URL_DVF.format(annee=annee, dep=dep))
            if etat is None:
                raise SystemExit(
                    "ERREUR : impossible de savoir si le millesime %d existe pour le\n"
                    "departement %s. files.data.gouv.fr est probablement indisponible.\n"
                    "Mieux vaut ne rien publier que publier une annee de moins sans le\n"
                    "dire. Relancer le robot plus tard." % (annee, dep))
            if not etat:
                # Un seul departement absent suffit a disqualifier l'annee : on
                # n'interroge pas les treize autres. Sans cet arret, l'annee en
                # cours -- qui n'est jamais encore publiee -- coutait autant de
                # sondages au lieu d'un, chacun pouvant etre reessaye trois fois.
                complet = False
                break
        if complet:
            trouvees.append(annee)
            if len(trouvees) == nb_annees:
                break
    return sorted(trouvees)


def tableau_de_couverture(millesimes, obtenus):
    """Le recapitulatif lisible, repris dans _rapport.txt et le resume GitHub."""
    lignes = ["  couverture (X = obtenu)" + "".join("%6s" % a for a in millesimes)]
    for dep in DEPARTEMENTS:
        cases = "".join("%6s" % ("X" if dep in obtenus[annee] else "-")
                        for annee in millesimes)
        lignes.append("  %-2s %-20.20s%s" % (dep, DEPARTEMENTS[dep]["nom"], cases))
    return lignes


def telecharger_millesimes(millesimes, dossier, telechargeur=telecharger):
    """Telecharge la matrice (annee x departement) et refuse de la publier trouee.

    Renvoie (fichiers, millesimes_reellement_obtenus). Les millesimes renvoyes
    sont ceux dont TOUS les departements ont ete telecharges : meta.json ne peut
    donc plus annoncer une annee absente des donnees. C'est le contrat que la
    regle I de controler() verifie de l'autre cote, sur les fichiers publies.

    Le parametre "telechargeur" n'existe que pour les tests : il permet de
    fabriquer n'importe quelle matrice de succes et d'echecs sans reseau.
    """
    obtenus = {}                                # annee -> {departement: chemin}
    for annee in millesimes:
        obtenus[annee] = {}
        for dep in DEPARTEMENTS:
            url = URL_DVF.format(annee=annee, dep=dep)
            destination = os.path.join(dossier, "%s-%s.csv.gz" % (dep, annee))
            journal("  telechargement %s %s" % (dep, annee))
            if telechargeur(url, destination):
                obtenus[annee][dep] = destination

    for ligne in tableau_de_couverture(millesimes, obtenus):
        journal(ligne)

    # Une annee absente pour TOUS les departements est une decision de l'Etat :
    # on la retire. Une annee absente pour une PARTIE seulement est une panne,
    # puisque millesimes_disponibles() a deja verifie que l'URL existe partout.
    retenus, abandonnes, trous = [], [], []
    for annee in millesimes:
        manquants = [dep for dep in DEPARTEMENTS if dep not in obtenus[annee]]
        if not manquants:
            retenus.append(annee)
        elif len(manquants) == len(DEPARTEMENTS):
            abandonnes.append(annee)
        else:
            trous.extend("%s en %s" % (dep, annee) for dep in manquants)

    if trous:
        raise SystemExit(
            "ERREUR : telechargement incomplet, rien ne sera publie.\n"
            "Manque(nt) apres %d tentatives : %s.\n"
            "Les donnees actuellement en ligne restent en place, ce qui vaut mieux\n"
            "qu'une mise a jour trouee. Relancer le robot plus tard."
            % (TENTATIVES_MAX, ", ".join(trous)))
    if abandonnes:
        journal("  millesime(s) introuvable(s) partout, donc retire(s) : %s"
                % ", ".join(str(annee) for annee in abandonnes))
    if len(retenus) < MIN_MILLESIMES:
        raise SystemExit(
            "ERREUR : %d annee(s) de donnees obtenue(s), il en faut au moins %d\n"
            "pour que l'indice de prix annuel ait un sens. Rien ne sera publie."
            % (len(retenus), MIN_MILLESIMES))

    fichiers = [obtenus[annee][dep] for annee in retenus for dep in DEPARTEMENTS]
    return fichiers, retenus


# --------------------------------------------------------------------------
# Lecture du CSV DVF en DEUX PASSES
# --------------------------------------------------------------------------
# Une meme vente ("mutation") s'etale sur plusieurs lignes du CSV. Pour decider
# si on la garde, il faut TOUTES ses lignes. Mais charger le fichier entier en
# memoire serait inutile : la grande majorite des mutations ne concerne aucune
# maison. On lit donc deux fois :
#   passe 1 : reperer les id_mutation qui contiennent au moins une "Maison"
#   passe 2 : ne conserver que ces mutations-la
# Cela divise l'occupation memoire par environ 10.

def ouvrir_csv(chemin):
    if chemin.endswith(".gz"):
        brut = gzip.open(chemin, "rb")
    else:
        brut = open(chemin, "rb")
    return io.TextIOWrapper(brut, encoding="utf-8", newline="")


def verifier_colonnes(noms_colonnes, chemin):
    manquantes = [c for c in COLONNES_REQUISES if c not in noms_colonnes]
    if manquantes:
        raise SystemExit(
            "ERREUR : le fichier %s ne contient pas les colonnes attendues : %s\n"
            "Le format des donnees DVF a probablement change. Il faut mettre a jour\n"
            "la liste COLONNES_REQUISES en haut de ce script avant de continuer."
            % (chemin, ", ".join(manquantes))
        )


def passe1_ids_maisons(chemin):
    """Renvoie l'ensemble des id_mutation comportant au moins une ligne 'Maison'."""
    ids = set()
    with ouvrir_csv(chemin) as flux:
        lecteur = csv.DictReader(flux)
        verifier_colonnes(lecteur.fieldnames or [], chemin)
        for ligne in lecteur:
            if ligne.get("type_local") == "Maison":
                ids.add(ligne["id_mutation"])
    return ids


def passe2_grouper(chemin, ids_gardes):
    """Regroupe les lignes des mutations retenues, par id_mutation."""
    groupes = defaultdict(list)
    with ouvrir_csv(chemin) as flux:
        for ligne in csv.DictReader(flux):
            identifiant = ligne["id_mutation"]
            if identifiant in ids_gardes:
                groupes[identifiant].append(ligne)
    return groupes


# --------------------------------------------------------------------------
# Consolidation d'une mutation + regles de rejet
# --------------------------------------------------------------------------

MOTIFS = [
    "R1_pas_une_vente", "R2_vente_mixte", "R3_plusieurs_maisons",
    "R4_lots_copropriete", "R5_plusieurs_communes", "R6_sans_coordonnees",
    "R7_champs_manquants", "B_bornes_implausibles",
]


def consolider(lignes, compteurs):
    """Transforme les lignes d'une mutation en UNE vente propre, ou None si rejetee.

    C'est ici que sont neutralises les deux grands pieges du fichier DVF :
      - piege 1 : valeur_fonciere est REPETEE sur chaque ligne. La sommer
                  multiplierait le prix par 2 a 5. On prend la premiere valeur.
      - piege 2 : surface_terrain est aussi repetee. On deduplique par parcelle.
    """
    premiere = lignes[0]

    # --- R1 : on ne garde que les vraies ventes -----------------------------
    if premiere.get("nature_mutation") != "Vente":
        compteurs["R1_pas_une_vente"] += 1
        return None

    # --- R4 : lot de copropriete -------------------------------------------
    for ligne in lignes:
        if (entier(ligne.get("nombre_lots")) or 0) > 1:
            compteurs["R4_lots_copropriete"] += 1
            return None

    # --- R2 : vente mixte (maison + appartement ou local professionnel) -----
    types = {l.get("type_local") for l in lignes if l.get("type_local")}
    if types - {"Maison", "Dépendance"}:
        compteurs["R2_vente_mixte"] += 1
        return None

    lignes_maison = [l for l in lignes if l.get("type_local") == "Maison"]

    # --- R3 : plusieurs maisons distinctes dans la meme vente ---------------
    parcelles_maison = {l.get("id_parcelle") for l in lignes_maison}
    if len(parcelles_maison) > 1:
        compteurs["R3_plusieurs_maisons"] += 1
        return None

    # --- R5 : la vente couvre plusieurs communes ----------------------------
    communes = {l.get("code_commune") for l in lignes if l.get("code_commune")}
    if len(communes) > 1:
        compteurs["R5_plusieurs_communes"] += 1
        return None

    # --- Piege 1 : NE JAMAIS SOMMER valeur_fonciere -------------------------
    valeurs_distinctes = {nombre(l.get("valeur_fonciere")) for l in lignes}
    valeurs_distinctes.discard(None)
    if len(valeurs_distinctes) > 1:
        # Assertion sur le format source : ne devrait jamais arriver.
        compteurs["_valeur_fonciere_incoherente"] += 1
    prix = next((nombre(l.get("valeur_fonciere")) for l in lignes
                 if nombre(l.get("valeur_fonciere")) is not None), None)

    # --- Surface batie : somme des lignes "Maison" --------------------------
    surfaces = [nombre(l.get("surface_reelle_bati")) for l in lignes_maison]
    surface_bati = sum(s for s in surfaces if s is not None)

    # --- Piege 2 : terrain dedoublonne par parcelle -------------------------
    terrain_par_parcelle = {}
    for ligne in lignes:
        parcelle = ligne.get("id_parcelle")
        valeur = nombre(ligne.get("surface_terrain"))
        if parcelle and valeur is not None:
            terrain_par_parcelle[parcelle] = valeur
    surface_terrain = sum(terrain_par_parcelle.values())

    # --- Pieces principales -------------------------------------------------
    pieces_liste = [entier(l.get("nombre_pieces_principales")) for l in lignes_maison]
    pieces_liste = [p for p in pieces_liste if p]
    pieces = max(pieces_liste) if pieces_liste else None
    if pieces is not None and not (1 <= pieces <= PIECES_MAX):
        pieces = None  # aberrant : on l'ignore, mais on ne rejette pas la vente

    # --- Coordonnees : la ligne "Maison" de plus grande surface -------------
    ligne_principale = max(
        lignes_maison,
        key=lambda l: nombre(l.get("surface_reelle_bati")) or 0.0,
    )
    lat = nombre(ligne_principale.get("latitude"))
    lon = nombre(ligne_principale.get("longitude"))

    t = mois_depuis_origine(premiere.get("date_mutation"))

    # --- R7 puis R6 ---------------------------------------------------------
    if prix is None or not surface_bati or t is None:
        compteurs["R7_champs_manquants"] += 1
        return None
    if lat is None or lon is None:
        compteurs["R6_sans_coordonnees"] += 1
        return None

    # --- Etage 1 du nettoyage : bornes absolues -----------------------------
    prix_m2 = prix / surface_bati
    if not (PRIX_MIN <= prix <= PRIX_MAX) \
            or not (BATI_MIN <= surface_bati <= BATI_MAX) \
            or not (0 <= surface_terrain <= TERRAIN_MAX) \
            or not (PRIX_M2_MIN <= prix_m2 <= PRIX_M2_MAX):
        compteurs["B_bornes_implausibles"] += 1
        return None

    numero = (ligne_principale.get("adresse_numero") or "").strip()
    suffixe = (ligne_principale.get("adresse_suffixe") or "").strip()
    voie = (ligne_principale.get("adresse_nom_voie") or "").strip()
    adresse = " ".join(p for p in [numero + suffixe, voie] if p).strip()

    return {
        "code_commune": premiere["code_commune"],
        "nom_commune": premiere.get("nom_commune", ""),
        "dep": premiere.get("code_departement", "").zfill(2),
        "t": t,
        "prix": round(prix),
        "sbati": round(surface_bati),
        "sterr": round(surface_terrain),
        "pieces": pieces,
        "lat": round(lat, 5),
        "lon": round(lon, 5),
        "adresse": adresse,
        "prix_m2": prix_m2,
    }


# --------------------------------------------------------------------------
# Etage 2 du nettoyage : valeurs aberrantes (MAD en espace logarithmique)
# --------------------------------------------------------------------------
# Le prix au m2 est fortement asymetrique a droite (quelques ventes tres cheres
# tirent la moyenne). En passant au logarithme, la distribution devient presque
# symetrique. On mesure alors la dispersion avec la MAD (ecart median absolu),
# qui resiste a 50 % de valeurs aberrantes -- contrairement a l'ecart-type, que
# les aberrations contaminent justement.

def seuil_mad(valeurs_log):
    """Renvoie (mediane, sigma_robuste) ou None si l'echantillon est trop petit."""
    if len(valeurs_log) < 3:
        return None
    med = statistics.median(valeurs_log)
    ecarts = [abs(v - med) for v in valeurs_log]
    mad = statistics.median(ecarts)
    if mad <= 0:
        return None
    return med, 1.4826 * mad


def filtrer_aberrations(ventes):
    """Retire les ventes aberrantes, commune par commune.

    Si une commune a moins de 8 ventes, sa MAD serait instable : on lui applique
    alors le seuil calcule au niveau du departement.
    """
    par_commune = defaultdict(list)
    par_departement = defaultdict(list)
    for vente in ventes:
        par_commune[vente["code_commune"]].append(vente)
        par_departement[vente["dep"]].append(vente)

    seuils_dep = {}
    for dep, liste in par_departement.items():
        seuils_dep[dep] = seuil_mad([math.log(v["prix_m2"]) for v in liste])

    gardees, retirees = [], 0
    for code, liste in par_commune.items():
        if len(liste) >= MIN_VENTES_MAD_COMMUNE:
            seuil = seuil_mad([math.log(v["prix_m2"]) for v in liste])
        else:
            seuil = seuils_dep.get(liste[0]["dep"])
        if seuil is None:
            gardees.extend(liste)
            continue
        med, sigma = seuil
        for vente in liste:
            if abs(math.log(vente["prix_m2"]) - med) <= SEUIL_MAD * sigma:
                gardees.append(vente)
            else:
                retirees += 1
    return gardees, retirees


# --------------------------------------------------------------------------
# Contours des communes : simplification TOPOLOGIQUEMENT SURE
# --------------------------------------------------------------------------
# 88,6 % des sommets des contours communaux sont partages par au moins deux
# communes voisines. Si on simplifiait chaque commune independamment, les deux
# cotes d'une meme frontiere seraient simplifies differemment et la carte
# afficherait des fentes blanches entre les communes.
#
# Solution : on utilise Douglas-Peucker uniquement pour DESIGNER les sommets a
# conserver, on fait l'UNION de ces designations sur tout le jeu de donnees,
# puis on reconstruit chaque contour a partir de cet ensemble commun. Une
# frontiere partagee garde ainsi exactement les memes sommets des deux cotes.

def arrondir_point(point):
    return (round(point[0], DECIMALES_CONTOURS), round(point[1], DECIMALES_CONTOURS))


def distance_au_segment(point, debut, fin):
    (px, py), (ax, ay), (bx, by) = point, debut, fin
    dx, dy = bx - ax, by - ay
    if dx == 0 and dy == 0:
        return math.hypot(px - ax, py - ay)
    projection = ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)
    projection = max(0.0, min(1.0, projection))
    return math.hypot(px - (ax + projection * dx), py - (ay + projection * dy))


def douglas_peucker_indices(points, epsilon):
    """Renvoie les indices des sommets a conserver (version iterative, sans recursion)."""
    if len(points) <= 2:
        return set(range(len(points)))
    conserves = {0, len(points) - 1}
    pile = [(0, len(points) - 1)]
    while pile:
        debut, fin = pile.pop()
        if fin <= debut + 1:
            continue
        distance_max, indice_max = 0.0, -1
        for i in range(debut + 1, fin):
            d = distance_au_segment(points[i], points[debut], points[fin])
            if d > distance_max:
                distance_max, indice_max = d, i
        if distance_max > epsilon and indice_max > 0:
            conserves.add(indice_max)
            pile.append((debut, indice_max))
            pile.append((indice_max, fin))
    return conserves


def parcourir_anneaux(geometrie):
    """Itere sur tous les anneaux d'un Polygon ou d'un MultiPolygon."""
    if geometrie["type"] == "Polygon":
        for anneau in geometrie["coordinates"]:
            yield anneau
    elif geometrie["type"] == "MultiPolygon":
        for polygone in geometrie["coordinates"]:
            for anneau in polygone:
                yield anneau


def nettoyer_anneau(anneau):
    """Arrondit les sommets et supprime les doublons consecutifs."""
    points, precedent = [], None
    for brut in anneau:
        point = arrondir_point(brut)
        if point != precedent:
            points.append(point)
            precedent = point
    # un anneau doit etre ferme
    if len(points) > 1 and points[0] != points[-1]:
        points.append(points[0])
    return points


def centroide(anneau):
    """Centroide d'aire (formule du lacet). Plus juste que la moyenne des sommets."""
    aire2 = cx = cy = 0.0
    for i in range(len(anneau) - 1):
        x0, y0 = anneau[i]
        x1, y1 = anneau[i + 1]
        produit = x0 * y1 - x1 * y0
        aire2 += produit
        cx += (x0 + x1) * produit
        cy += (y0 + y1) * produit
    if abs(aire2) < 1e-12:
        xs = [p[0] for p in anneau]
        ys = [p[1] for p in anneau]
        return sum(xs) / len(xs), sum(ys) / len(ys)
    return cx / (3 * aire2), cy / (3 * aire2)


def construire_contours(geojsons_par_dep):
    """Simplifie les contours et deduit l'adjacence des communes.

    Renvoie (geojson_simplifie, adjacence, centroides).
    """
    # --- etape 1 : nettoyage (arrondi + deduplication) ----------------------
    communes = []  # [{code, dep, anneaux: [[(x,y), ...], ...]}]
    for dep, geojson in geojsons_par_dep.items():
        for entite in geojson["features"]:
            code = entite["properties"]["code"]
            anneaux = [nettoyer_anneau(a) for a in parcourir_anneaux(entite["geometry"])]
            anneaux = [a for a in anneaux if len(a) >= 4]
            if anneaux:
                communes.append({"code": code, "dep": dep, "anneaux": anneaux,
                                 "type": entite["geometry"]["type"]})

    # --- etape 2 : adjacence par sommets partages ---------------------------
    # Cadeau de la topologie : aucune bibliotheque geometrique necessaire.
    proprietaires = defaultdict(set)
    for commune in communes:
        for anneau in commune["anneaux"]:
            for point in anneau:
                proprietaires[point].add(commune["code"])
    adjacence = defaultdict(set)
    for codes in proprietaires.values():
        if len(codes) > 1:
            for code in codes:
                adjacence[code].update(codes - {code})

    # --- etape 3 : ensemble GLOBAL des sommets a conserver ------------------
    a_conserver = set()
    for commune in communes:
        for anneau in commune["anneaux"]:
            indices = douglas_peucker_indices(anneau, EPSILON_DP)
            for i in indices:
                a_conserver.add(anneau[i])

    # --- etape 4 : reconstruction ------------------------------------------
    entites, centroides = [], {}
    total_avant = total_apres = 0
    for commune in communes:
        anneaux_simplifies = []
        for anneau in commune["anneaux"]:
            total_avant += len(anneau)
            reduit = [p for p in anneau if p in a_conserver]
            if len(reduit) > 1 and reduit[0] != reduit[-1]:
                reduit.append(reduit[0])
            if len(reduit) >= 4:
                anneaux_simplifies.append(reduit)
                total_apres += len(reduit)
        if not anneaux_simplifies:
            anneaux_simplifies = [commune["anneaux"][0]]

        plus_grand = max(anneaux_simplifies, key=len)
        cx, cy = centroide(plus_grand)
        centroides[commune["code"]] = (round(cy, 5), round(cx, 5))  # (lat, lon)

        if commune["type"] == "Polygon" or len(anneaux_simplifies) == 1:
            geometrie = {"type": "Polygon",
                         "coordinates": [[list(p) for p in a] for a in anneaux_simplifies]}
        else:
            geometrie = {"type": "MultiPolygon",
                         "coordinates": [[[list(p) for p in a]] for a in anneaux_simplifies]}
        entites.append({"type": "Feature",
                        "properties": {"code": commune["code"]},
                        "geometry": geometrie})

    journal("  contours : %d sommets -> %d (%.0f %% retires)"
            % (total_avant, total_apres,
               100 * (1 - total_apres / max(total_avant, 1))))
    return ({"type": "FeatureCollection", "features": entites},
            {code: sorted(voisins) for code, voisins in adjacence.items()},
            centroides)


# --------------------------------------------------------------------------
# Indice de prix annuel + prix marginal du terrain
# --------------------------------------------------------------------------

def calculer_indice_prix(ventes):
    """Mediane du prix au m2 par departement et par annee, normalisee sur la
    derniere annee. Sert a ramener une vente ancienne au niveau d'aujourd'hui.
    """
    par_dep_annee = defaultdict(list)
    for vente in ventes:
        par_dep_annee[(vente["dep"], annee_depuis_mois(vente["t"]))].append(vente["prix_m2"])

    indice = defaultdict(dict)
    for (dep, annee), valeurs in par_dep_annee.items():
        if len(valeurs) >= 20:
            indice[dep][annee] = mediane(valeurs)

    for dep, par_annee in indice.items():
        if not par_annee:
            continue
        reference = par_annee[max(par_annee)]
        for annee in par_annee:
            par_annee[annee] = round(par_annee[annee] / reference, 4)
    return {dep: {str(a): v for a, v in sorted(par_annee.items())}
            for dep, par_annee in indice.items()}


def points_terrain(ventes, prix_m2_bati_median):
    """Prepare les couples (surface de terrain, prix restant une fois le bati deduit).

    Le "prix restant" est calcule avec la mediane de LA COMMUNE, jamais celle du
    departement. C'est essentiel : les communes cheres ont de petites parcelles et
    les communes rurales de grandes. Deduire le bati avec une mediane
    departementale melangerait ces deux effets et inverserait la pente -- mesure
    faite sur les donnees reelles, cela donnait 0,5 EUR/m2 pour le Gard, soit la
    valeur plancher, alors que la bonne reponse est autour de 22.
    """
    points = []
    for vente in ventes:
        if vente["sterr"] <= 0:
            continue
        x = min(float(vente["sterr"]), TERRAIN_PLAFOND_REGRESSION)
        points.append((x, vente["prix"] - prix_m2_bati_median * vente["sbati"]))
    return points


def pente_theil_sen(points, alea):
    """Combien vaut un m2 de terrain en plus ? Renvoie None si ce n'est pas fiable.

    On prend la MEDIANE des pentes calculees deux a deux (estimateur de
    Theil-Sen), et non la moyenne des moindres carres. Raison mesuree sur le Gard
    et l'Ardeche reels : le prix d'une maison depend surtout de son etat, de ses
    travaux et de sa vue -- que DVF ne connait pas. Ce bruit est enorme devant
    l'effet du terrain et fait deraper une regression classique (38 % de pentes
    absurdes, contre 27 % avec Theil-Sen). Il faut en plus beaucoup de ventes :
    a 80 ventes l'estimation est deja tiree vers zero, a 300 elle tient meme sous
    un bruit de 80 000 EUR.
    """
    n = len(points)
    if n < MIN_VENTES_REGRESSION_TERRAIN:
        return None

    pentes = []
    if n * (n - 1) // 2 <= MAX_PAIRES_THEIL_SEN:
        for i in range(n):
            for j in range(i + 1, n):
                if points[j][0] != points[i][0]:
                    pentes.append((points[j][1] - points[i][1])
                                  / (points[j][0] - points[i][0]))
    else:
        # Trop de paires pour les prendre toutes : on en tire un echantillon.
        # La graine est fixee par l'appelant, donc le resultat est reproductible.
        for _ in range(MAX_PAIRES_THEIL_SEN):
            i, j = alea.randrange(n), alea.randrange(n)
            if i != j and points[j][0] != points[i][0]:
                pentes.append((points[j][1] - points[i][1])
                              / (points[j][0] - points[i][0]))
    if not pentes:
        return None

    pente = statistics.median(pentes)
    # Hors de la plage plausible, on considere que rien de fiable n'a ete trouve.
    if not (PRIX_TERRAIN_MIN <= pente <= PRIX_TERRAIN_MAX):
        return None
    return round(pente, 1)


def calculer_bandes(ventes):
    """Table de repli : statistiques par bande de surface, pour un departement."""
    lignes = []
    for borne_inf, borne_sup in BANDES_SURFACE:
        prix_m2 = sorted(v["prix_m2"] for v in ventes
                         if borne_inf <= v["sbati"] < borne_sup)
        if len(prix_m2) < 5:
            continue
        lignes.append([borne_inf, borne_sup, len(prix_m2),
                       round(quantile(prix_m2, 0.25)),
                       round(quantile(prix_m2, 0.50)),
                       round(quantile(prix_m2, 0.75))])
    return {"champs": ["borne_inf", "borne_sup", "n", "m2_q1", "m2_med", "m2_q3"],
            "valeurs": lignes}


# --------------------------------------------------------------------------
# Ecriture des fichiers de sortie
# --------------------------------------------------------------------------

# Un numero de voirie en tete d'adresse : "12 RUE AMPERE", "3038 RTE DE ...",
# parfois suivi d'un indice ("12 B RUE ..."). On le retire pour obtenir le
# libelle de voie, qui est ce que l'annuaire recense.
NUMERO_DE_VOIRIE = re.compile(r"^\d+\s*(?:[A-Z]\s+)?")
# Quelques adresses DVF commencent par de la ponctuation isolee : "- AV
# MARECHAL KOENIG", ". AV DE SAINT CASSIEN". Elle n'appartient pas au nom.
BRUIT_DE_TETE = re.compile(r"^[^0-9A-Za-z\u00c0-\u017f]+")


def libelle_de_voie(adresse):
    """« 12 B RUE AMPERE » -> « RUE AMPERE »."""
    texte = BRUIT_DE_TETE.sub("", adresse or "")
    texte = NUMERO_DE_VOIRIE.sub("", texte)
    return BRUIT_DE_TETE.sub("", texte).strip()


def construire_index_voies(par_commune):
    """Recense les libelles de voie et les communes ou ils apparaissent.

    C'est un ANNUAIRE, pas un catalogue de ventes : il dit ou chercher, pas ce
    qu'on y trouvera. Le site s'en sert pour retrouver une adresse tapee sans
    avoir choisi de ville ; les prix, eux, viennent du fichier de la commune,
    telecharge ensuite. Cette separation est ce qui garde l'annuaire a 0,8 Mo
    compresse au lieu de 4,4 Mo si l'on y mettait les ventes elles-memes.
    """
    voies = defaultdict(set)
    for code, liste in par_commune.items():
        for vente in liste:
            voie = libelle_de_voie(vente["adresse"])
            if voie:
                voies[voie].add(code)
    return {"champs": ["voie", "communes"],
            "valeurs": [[voie, sorted(codes)] for voie, codes in sorted(voies.items())]}


CHAMPS_COMMUNE = ["code", "nom", "dep", "lat", "lon", "n", "m2_med", "m2_q1",
                  "m2_q3", "surf_med", "terr_med", "prix_med", "prix_terrain"]
CHAMPS_VENTE = ["t", "prix", "sbati", "sterr", "pieces", "lat", "lon", "adresse"]


def ecrire_json(chemin, donnees):
    os.makedirs(os.path.dirname(chemin), exist_ok=True)
    with open(chemin, "w", encoding="utf-8") as sortie:
        json.dump(donnees, sortie, ensure_ascii=False, separators=(",", ":"))


def construire_sorties(ventes, contours, adjacence, centroides, noms_communes,
                       millesimes, dossier):
    # On repart d'un dossier de ventes vide : sinon les fichiers d'une execution
    # precedente (par exemple le jeu de demonstration) survivraient pour les
    # communes qui n'ont plus aucune vente.
    shutil.rmtree(os.path.join(dossier, "ventes"), ignore_errors=True)

    par_commune = defaultdict(list)
    for vente in ventes:
        par_commune[vente["code_commune"]].append(vente)

    codes_geo = {e["properties"]["code"] for e in contours["features"]}
    tous_codes = sorted(codes_geo | set(par_commune))

    t_reference = max((v["t"] for v in ventes), default=0)

    ventes_par_dep = defaultdict(list)
    for vente in ventes:
        ventes_par_dep[vente["dep"]].append(vente)

    # Prix du terrain : on calcule d'abord commune par commune, puis la valeur
    # departementale est la MEDIANE de ces resultats communaux.
    # Surtout pas une regression sur le departement entier : les communes cheres
    # ont de petites parcelles et les communes rurales de grandes, ce qui inverse
    # artificiellement la pente. Mesure faite : cette approche donnait 0,5 EUR/m2
    # pour le Gard (valeur plancher, absurde) la ou la mediane communale donne 28.
    alea = random.Random(20260101)
    points_par_dep = defaultdict(list)
    for code, liste in par_commune.items():
        if len(liste) < MIN_VENTES_AFFICHAGE:
            continue
        points_par_dep[liste[0]["dep"]].extend(
            points_terrain(liste, mediane([v["prix_m2"] for v in liste])))

    # Le resultat peut etre None, et c'est une reponse legitime : dans les
    # Alpes-Maritimes et le Var, la pente mesuree est NEGATIVE (-5 et -16 EUR/m2,
    # stable d'un tirage a l'autre). Ce n'est pas une erreur de calcul mais la
    # realite de ces marches : une fois la valeur du bati retiree, les grands
    # terrains sont dans l'arriere-pays, moins cher, tandis que la prime est au
    # bord de mer sur de petites parcelles. La surface de terrain n'y explique
    # donc pas le prix. Plutot que de lui substituer un chiffre invente, on
    # laisse None : le site n'y proposera simplement pas l'ajustement terrain.
    prix_terrain_dep = {dep: pente_theil_sen(points_par_dep[dep], alea)
                        for dep in DEPARTEMENTS}
    journal("  prix du terrain (valeur departementale) : " + ", ".join(
        "%s = %s sur %d ventes avec terrain"
        % (dep,
           ("%.1f EUR/m2" % prix_terrain_dep[dep]) if prix_terrain_dep[dep] is not None
           else "non mesurable (aucun ajustement propose)",
           len(points_par_dep[dep])) for dep in DEPARTEMENTS))

    lignes_communes = []
    for code in tous_codes:
        liste = par_commune.get(code, [])
        dep = code[:2] if code[:2] in DEPARTEMENTS else (liste[0]["dep"] if liste else "30")
        lat, lon = centroides.get(code, (None, None))
        nom = noms_communes.get(code) or code

        n = len(liste)
        if n >= MIN_VENTES_AFFICHAGE:
            prix_m2 = sorted(v["prix_m2"] for v in liste)
            m2_med = round(quantile(prix_m2, 0.50))
            m2_q1 = round(quantile(prix_m2, 0.25))
            m2_q3 = round(quantile(prix_m2, 0.75))
            surf_med = round(mediane([v["sbati"] for v in liste]))
            terr_med = round(mediane([v["sterr"] for v in liste]))
            prix_med = round(mediane([v["prix"] for v in liste]))
        else:
            m2_med = m2_q1 = m2_q3 = surf_med = terr_med = prix_med = None
        # Valeur du departement, ou None si le terrain n'y explique pas le prix
        # (voir le commentaire au calcul de prix_terrain_dep).
        terrain = prix_terrain_dep.get(dep)

        lignes_communes.append([code, nom, dep, lat, lon, n, m2_med, m2_q1, m2_q3,
                                surf_med, terr_med, prix_med, terrain])

        # un fichier de ventes par commune, charge uniquement quand on clique
        if liste:
            liste.sort(key=lambda v: -v["t"])
            ecrire_json(
                os.path.join(dossier, "ventes", dep, code + ".json"),
                {"code": code, "champs": CHAMPS_VENTE,
                 "ventes": [[v["t"], v["prix"], v["sbati"], v["sterr"], v["pieces"],
                             v["lat"], v["lon"], v["adresse"]] for v in liste]},
            )

    # seuils de couleur : quantiles des medianes communales (7 classes)
    medianes = sorted(l[6] for l in lignes_communes if l[6] is not None)
    seuils = [round(quantile(medianes, q)) for q in (1/7, 2/7, 3/7, 4/7, 5/7, 6/7)] \
        if len(medianes) >= 7 else []

    ecrire_json(os.path.join(dossier, "communes.json"),
                {"champs": CHAMPS_COMMUNE, "valeurs": lignes_communes})
    ecrire_json(os.path.join(dossier, "communes-geo.json"), contours)
    ecrire_json(os.path.join(dossier, "adjacence.json"), adjacence)
    # Annuaire des voies : telecharge seulement quand on cherche une adresse.
    ecrire_json(os.path.join(dossier, "voies.json"), construire_index_voies(par_commune))

    for dep in DEPARTEMENTS:
        ecrire_json(os.path.join(dossier, "bandes-%s.json" % dep),
                    calculer_bandes(ventes_par_dep[dep]))

    meta = {
        "genere_le": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "millesimes": millesimes,
        "annee_origine": ANNEE_ORIGINE,
        "mois_reference": t_reference,
        "nb_ventes": len(ventes),
        "min_ventes_affichage": MIN_VENTES_AFFICHAGE,
        # On ne declare que les departements ayant reellement des ventes : un
        # departement vide n'a pas de mediane, et une mediane a zero ferait
        # echouer les controles de coherence pour une mauvaise raison.
        "departements": {
            dep: {
                "nom": DEPARTEMENTS[dep]["nom"],
                "nb_ventes": len(ventes_par_dep[dep]),
                "prix_m2_median": round(mediane([v["prix_m2"] for v in ventes_par_dep[dep]])),
            } for dep in DEPARTEMENTS if ventes_par_dep[dep]
        },
        "seuils_couleurs": seuils,
        "indice_prix": calculer_indice_prix(ventes),
        "prix_terrain_defaut": prix_terrain_dep,
    }
    ecrire_json(os.path.join(dossier, "meta.json"), meta)
    return meta


# --------------------------------------------------------------------------
# Controles de coherence : mieux vaut echouer que publier des chiffres faux
# --------------------------------------------------------------------------

# Bornes de la France metropolitaine, pour reperer une coordonnee absurde.
LAT_MIN, LAT_MAX = 41.0, 51.5
LON_MIN, LON_MAX = -5.5, 9.8
# Part maximale de communes sans contour. Ce ne sont pas des erreurs : ce sont
# des communes fusionnees, presentes dans DVF sans contour propre. Mesure
# actuelle : 0,4 %. Le seuil sert a reperer une degradation, pas a exiger zero.
PART_MAX_SANS_CONTOUR = 0.01
# Une annee doit peser dans un departement au moins 40 % de ce qu'elle pese
# ailleurs. Forme RELATIVE, donc insensible a un dernier millesime partiel.
# Mesure actuelle : le rapport le plus faible vaut 0,93.
RAPPORT_MIN_COUVERTURE = 0.40
# En dessous de ce volume, un departement peut n'avoir aucune tranche de surface
# remplie (il en faut 5 ventes par tranche) : ce n'est pas une anomalie.
MIN_VENTES_POUR_BANDES = 50


def controler(dossier, tolerant=False):
    """Relit TOUS les fichiers produits et renvoie la liste des problemes.

    Separee de verifier() pour servir a deux moments : le robot l'appelle sur
    les donnees fraiches AVANT de les commiter, et l'integration continue
    l'appelle sur les donnees DEJA commitees. Une seule implementation, donc
    aucune divergence possible entre ce qui bloque la publication et ce qui
    bloque une modification du code.
    """
    problemes = []

    def charger(nom):
        chemin = os.path.join(dossier, nom)
        if not os.path.exists(chemin):
            problemes.append("fichier manquant : %s" % nom)
            return None
        try:
            with open(chemin, encoding="utf-8") as flux:
                return json.load(flux)
        except ValueError:
            problemes.append("fichier illisible : %s" % nom)
            return None

    meta = charger("meta.json")
    communes = charger("communes.json")
    contours = charger("communes-geo.json")
    adjacence = charger("adjacence.json")
    if meta is None or communes is None:
        return problemes

    # --- A. meta.json -----------------------------------------------------
    for cle in ("millesimes", "mois_reference", "nb_ventes", "annee_origine",
                "seuils_couleurs", "indice_prix", "prix_terrain_defaut", "departements"):
        if cle not in meta:
            problemes.append("meta.json : champ '%s' manquant" % cle)
    if problemes:
        return problemes

    seuils = meta["seuils_couleurs"]
    if seuils and any(a >= b for a, b in zip(seuils, seuils[1:])):
        problemes.append("meta.json : seuils_couleurs pas strictement croissants : %s" % seuils)
    for dep in meta["departements"]:
        if dep not in meta["prix_terrain_defaut"]:
            problemes.append("meta.json : prix_terrain_defaut absent pour %s" % dep)
        # L'indice de prix annuel demande au moins 20 ventes par annee : un jeu
        # de test minuscule n'en produit aucun, et c'est legitime. En production
        # il doit exister pour chaque departement.
        if not tolerant and dep not in meta["indice_prix"]:
            problemes.append("meta.json : indice_prix absent pour le departement %s" % dep)

    # --- B. communes.json -------------------------------------------------
    if communes.get("champs") != CHAMPS_COMMUNE:
        problemes.append("communes.json : liste de champs inattendue")
        return problemes
    index = {nom: i for i, nom in enumerate(CHAMPS_COMMUNE)}
    par_code = {}
    for ligne in communes["valeurs"]:
        code = ligne[index["code"]]
        if code in par_code:
            problemes.append("communes.json : code en double : %s" % code)
        par_code[code] = ligne
        if ligne[index["dep"]] not in DEPARTEMENTS:
            problemes.append("commune %s : departement inconnu %s" % (code, ligne[index["dep"]]))
        q1, med, q3 = (ligne[index[c]] for c in ("m2_q1", "m2_med", "m2_q3"))
        if med is not None and not (q1 <= med <= q3):
            problemes.append("commune %s : quartiles incoherents (%s / %s / %s)"
                             % (code, q1, med, q3))
        assez = ligne[index["n"]] >= MIN_VENTES_AFFICHAGE
        if assez != (med is not None):
            problemes.append("commune %s : %d vente(s) mais mediane %s"
                             % (code, ligne[index["n"]], "presente" if med is not None else "absente"))

    # --- C. totaux --------------------------------------------------------
    somme = sum(l[index["n"]] for l in communes["valeurs"])
    if somme != meta["nb_ventes"]:
        problemes.append("total incoherent : somme des communes = %d, meta.nb_ventes = %d"
                         % (somme, meta["nb_ventes"]))
    somme_dep = sum(d["nb_ventes"] for d in meta["departements"].values())
    if somme_dep != meta["nb_ventes"]:
        problemes.append("total par departement = %d, meta.nb_ventes = %d"
                         % (somme_dep, meta["nb_ventes"]))

    # --- D + E. fichiers de ventes ---------------------------------------
    # Un seul parcours : on lit chaque fichier une fois et on verifie tout.
    attendus = {l[index["code"]] for l in communes["valeurs"] if l[index["n"]] > 0}
    dossier_ventes = os.path.join(dossier, "ventes")
    presents, ventes_par_dep_annee = set(), defaultdict(lambda: defaultdict(int))
    if os.path.isdir(dossier_ventes):
        for sous in sorted(os.listdir(dossier_ventes)):
            for fichier in sorted(os.listdir(os.path.join(dossier_ventes, sous))):
                if not fichier.endswith(".json"):
                    continue
                code = fichier[:-5]
                presents.add(code)
                with open(os.path.join(dossier_ventes, sous, fichier), encoding="utf-8") as flux:
                    table = json.load(flux)
                if code not in par_code:
                    continue          # signale plus bas comme orphelin
                if table.get("champs") != CHAMPS_VENTE or table.get("code") != code:
                    problemes.append("ventes/%s/%s : en-tete incoherent" % (sous, fichier))
                    continue
                attendu = par_code[code][index["n"]]
                if len(table["ventes"]) != attendu:
                    problemes.append("commune %s : %d ventes dans le fichier, %d annoncees"
                                     % (code, len(table["ventes"]), attendu))
                position = {nom: i for i, nom in enumerate(CHAMPS_VENTE)}
                precedent = None
                for vente in table["ventes"]:
                    t = vente[position["t"]]
                    ventes_par_dep_annee[code[:2]][annee_depuis_mois(t)] += 1
                    if precedent is not None and t > precedent:
                        # Un seul signalement par fichier : l'information est
                        # « ce fichier est mal trie », pas « voici 400 paires ».
                        problemes.append("commune %s : ventes non triees de la plus recente "
                                         "a la plus ancienne" % code)
                        break
                    precedent = t
                    if vente[position["prix"]] <= 0 or vente[position["sbati"]] <= 0:
                        problemes.append("commune %s : vente a prix ou surface nulle" % code)
                        break
                    if not (0 <= t <= meta["mois_reference"]):
                        problemes.append("commune %s : date hors periode (t=%s)" % (code, t))
                        break
                    lat, lon = vente[position["lat"]], vente[position["lon"]]
                    if lat is None or lon is None or not (
                            LAT_MIN < lat < LAT_MAX and LON_MIN < lon < LON_MAX):
                        problemes.append("commune %s : vente hors de France (%s, %s)"
                                         % (code, lat, lon))
                        break

    for code in sorted(attendus - presents):
        problemes.append("commune %s : %d ventes annoncees mais aucun fichier"
                         % (code, par_code[code][index["n"]]))
    for code in sorted(presents - attendus):
        problemes.append("fichier de ventes orphelin : %s (aucune vente annoncee)" % code)

    # --- F. contours ------------------------------------------------------
    if contours is not None:
        codes_geo = {e["properties"]["code"] for e in contours.get("features", [])}
        for code in sorted(codes_geo - set(par_code)):
            problemes.append("contour d'une commune inconnue : %s" % code)
        sans_contour = len(set(par_code) - codes_geo)
        part = sans_contour / max(len(par_code), 1)
        if part > PART_MAX_SANS_CONTOUR:
            problemes.append("%d communes sans contour (%.1f %%), au-dela de %.0f %%"
                             % (sans_contour, 100 * part, 100 * PART_MAX_SANS_CONTOUR))

    # --- G. adjacence -----------------------------------------------------
    if adjacence is not None:
        for code, voisins in adjacence.items():
            if code not in par_code:
                problemes.append("adjacence : commune inconnue %s" % code)
                continue
            if code in voisins:
                problemes.append("adjacence : %s se declare sa propre voisine" % code)
            if len(set(voisins)) != len(voisins):
                problemes.append("adjacence : doublons chez %s" % code)
            for voisin in voisins:
                if voisin not in par_code:
                    problemes.append("adjacence : %s voisine d'une commune inconnue %s"
                                     % (code, voisin))
                elif code not in adjacence.get(voisin, []):
                    problemes.append("adjacence non symetrique : %s -> %s mais pas l'inverse"
                                     % (code, voisin))

    # --- H. les fichiers de bandes, TOUS les departements -----------------
    for dep in DEPARTEMENTS:
        bandes = charger("bandes-%s.json" % dep)
        if bandes is None:
            continue
        # Une tranche demande au moins 5 ventes : un departement peu fourni a
        # donc legitimement des bandes vides. On n'exige des tranches qu'au-dela
        # d'un volume ou leur absence signalerait vraiment un probleme.
        if not bandes.get("valeurs"):
            ventes_dep = meta["departements"].get(dep, {}).get("nb_ventes", 0)
            if ventes_dep >= MIN_VENTES_POUR_BANDES:
                problemes.append("bandes-%s.json : aucune tranche de surface alors que le "
                                 "departement compte %d ventes" % (dep, ventes_dep))
            continue
        for borne_inf, borne_sup, _n, q1, med, q3 in bandes["valeurs"]:
            if (borne_inf, borne_sup) not in BANDES_SURFACE:
                problemes.append("bandes-%s.json : tranche inattendue %s-%s"
                                 % (dep, borne_inf, borne_sup))
            if not (q1 <= med <= q3):
                problemes.append("bandes-%s.json : quartiles incoherents sur %s-%s"
                                 % (dep, borne_inf, borne_sup))

    # --- I. couverture (departement x annee) ------------------------------
    # Le vrai filet contre un telechargement partiel : on ne fait pas confiance
    # a ce que meta.json declare, on recalcule depuis les ventes elles-memes.
    millesimes = [a for a in meta["millesimes"] if isinstance(a, int)]
    if not tolerant and millesimes and ventes_par_dep_annee:
        for annee in millesimes:
            parts = {}
            for dep, par_annee in ventes_par_dep_annee.items():
                total = sum(par_annee.values())
                if total:
                    parts[dep] = par_annee.get(annee, 0) / total
            if len(parts) < 2:
                continue
            reference = mediane(list(parts.values()))
            if not reference:
                continue
            for dep, part in sorted(parts.items()):
                if part / reference < RAPPORT_MIN_COUVERTURE:
                    problemes.append(
                        "couverture incomplete : %s en %d ne pese que %.1f %% de ses ventes, "
                        "contre %.1f %% ailleurs - millesime probablement manquant"
                        % (dep, annee, 100 * part, 100 * reference))

    # --- K. annuaire des voies --------------------------------------------
    # Ce fichier est telecharge par le site quand on cherche une adresse. S'il
    # est absent ou incoherent, la recherche d'adresse echoue en silence.
    chemin_voies = os.path.join(dossier, "voies.json")
    if not os.path.exists(chemin_voies):
        problemes.append("voies.json : fichier absent")
    else:
        with open(chemin_voies, encoding="utf-8") as flux:
            voies = json.load(flux)
        if voies.get("champs") != ["voie", "communes"]:
            problemes.append("voies.json : champs inattendus %s" % (voies.get("champs"),))
        else:
            precedent = None
            inconnues = set()
            communes_citees = set()
            for voie, codes in voies["valeurs"]:
                if not voie or not voie.strip():
                    problemes.append("voies.json : libelle de voie vide")
                if precedent is not None and voie < precedent:
                    problemes.append("voies.json : libelles mal tries (%s apres %s)"
                                     % (voie, precedent))
                    precedent = None
                    break
                precedent = voie
                if not codes:
                    problemes.append("voies.json : %s n'est rattachee a aucune commune" % voie)
                for code in codes:
                    communes_citees.add(code)
                    if code not in par_code:
                        inconnues.add(code)
            if inconnues:
                problemes.append("voies.json : %d code(s) de commune inconnu(s), dont %s"
                                 % (len(inconnues), ", ".join(sorted(inconnues)[:5])))
            # Toute commune qui a des ventes doit apparaitre dans l'annuaire :
            # sinon son adresse serait introuvable alors que ses ventes existent.
            avec_ventes = {code for code, ligne in par_code.items()
                           if ligne[index["n"]] > 0}
            manquantes = sorted(avec_ventes - communes_citees)
            if manquantes:
                problemes.append("voies.json : %d commune(s) a ventes absente(s) de "
                                 "l'annuaire, dont %s"
                                 % (len(manquantes), ", ".join(manquantes[:5])))

    # --- J. volumes et plausibilite (controles historiques) ---------------
    seuil_ventes = 10 if tolerant else 60_000
    seuil_communes = 1 if tolerant else 1_200
    seuil_par_departement = 0 if tolerant else 2_000

    if meta["nb_ventes"] < seuil_ventes:
        problemes.append("seulement %d ventes retenues (attendu >= %d)"
                         % (meta["nb_ventes"], seuil_ventes))
    coloriables = sum(1 for l in communes["valeurs"] if l[index["m2_med"]] is not None)
    if coloriables < seuil_communes:
        problemes.append("seulement %d communes exploitables (attendu >= %d)"
                         % (coloriables, seuil_communes))
    if not tolerant:
        manquants = [d for d in DEPARTEMENTS if d not in meta["departements"]]
        if manquants:
            problemes.append("departements absents du resultat : " + ", ".join(manquants))

    for dep, infos in sorted(meta["departements"].items()):
        if infos["nb_ventes"] < seuil_par_departement:
            problemes.append("departement %s : seulement %d ventes (attendu >= %d) "
                             "- telechargement probablement incomplet"
                             % (dep, infos["nb_ventes"], seuil_par_departement))
        if infos["nb_ventes"] == 0:
            continue
        prix = infos["prix_m2_median"]
        # Intervalle large : il va de l'Ardeche rurale a la Cote d'Azur. Il ne
        # sert qu'a reperer un resultat absurde, pas a juger un marche.
        if not (700 <= prix <= 12_000):
            problemes.append("mediane %s = %d EUR/m2, hors de l'intervalle plausible "
                             "700-12000" % (dep, prix))

    return problemes


def verifier(dossier, tolerant=False):
    """Imprime les problemes trouves et renvoie True si tout est conforme."""
    problemes = controler(dossier, tolerant)
    for probleme in problemes:
        print("ECHEC : " + probleme)
    if not problemes:
        with open(os.path.join(dossier, "meta.json"), encoding="utf-8") as flux:
            meta = json.load(flux)
        print("Controles de coherence : tout est conforme (%d ventes)." % meta["nb_ventes"])
    return not problemes

# --------------------------------------------------------------------------
# Programme principal
# --------------------------------------------------------------------------

def charger_geojson_local(dossier, dep):
    for nom in ("communes_test.geojson", "communes-%s.geojson" % dep):
        chemin = os.path.join(dossier, nom)
        if os.path.exists(chemin):
            with open(chemin, encoding="utf-8") as flux:
                geojson = json.load(flux)
            entites = [e for e in geojson["features"]
                       if e["properties"]["code"].startswith(dep)]
            return {"type": "FeatureCollection", "features": entites}
    return {"type": "FeatureCollection", "features": []}


def main():
    analyseur = argparse.ArgumentParser(description=__doc__)
    analyseur.add_argument("--annees", type=int, default=5,
                           help="nombre d'annees d'historique a recuperer")
    analyseur.add_argument("--sortie", default="data", help="dossier de sortie")
    analyseur.add_argument("--source-locale", default=None,
                           help="dossier contenant des fichiers de test (mode hors ligne)")
    analyseur.add_argument("--verifier", default=None,
                           help="verifier un dossier deja produit, puis quitter")
    analyseur.add_argument("--tolerant", action="store_true",
                           help="assouplit les seuils de controle (jeu de demonstration)")
    options = analyseur.parse_args()

    if options.verifier:
        sys.exit(0 if verifier(options.verifier, options.tolerant) else 1)

    compteurs = defaultdict(int)
    ventes_brutes = []
    noms_communes = {}
    millesimes = []
    dossier_temporaire = tempfile.mkdtemp(prefix="dvf-")

    try:
        # ---------------- Etape 1 : les ventes ------------------------------
        if options.source_locale:
            journal("Mode hors ligne : lecture de %s" % options.source_locale)
            millesimes = ["fixtures"]
            fichiers = [os.path.join(options.source_locale, "dvf_echantillon.csv")]
        else:
            journal("Recherche des millesimes DVF disponibles...")
            millesimes = millesimes_disponibles(options.annees)
            if len(millesimes) < MIN_MILLESIMES:
                raise SystemExit(
                    "ERREUR : moins de %d annees de donnees DVF trouvees.\n"
                    "Le site files.data.gouv.fr est peut-etre indisponible, ou la\n"
                    "structure des URL a change. Reessayer plus tard." % MIN_MILLESIMES)
            journal("Millesimes candidats : %s" % ", ".join(map(str, millesimes)))
            # millesimes est REAFFECTE : seules les annees reellement ingerees
            # seront annoncees dans meta.json.
            fichiers, millesimes = telecharger_millesimes(millesimes, dossier_temporaire)
            journal("Millesimes retenus : %s" % ", ".join(map(str, millesimes)))

        for chemin in fichiers:
            ids = passe1_ids_maisons(chemin)
            groupes = passe2_grouper(chemin, ids)
            compteurs["mutations_avec_maison"] += len(groupes)
            for lignes in groupes.values():
                vente = consolider(lignes, compteurs)
                if vente is not None:
                    ventes_brutes.append(vente)
                    noms_communes.setdefault(vente["code_commune"], vente["nom_commune"])

        journal("Mutations contenant une maison : %d" % compteurs["mutations_avec_maison"])
        for motif in MOTIFS:
            if compteurs[motif]:
                journal("  rejet %-24s %6d" % (motif, compteurs[motif]))
        journal("  valeur_fonciere incoherente entre lignes : %d  (doit rester 0)"
                % compteurs["_valeur_fonciere_incoherente"])

        ventes, retirees = filtrer_aberrations(ventes_brutes)
        journal("Aberrations retirees (MAD) : %d sur %d (%.1f %%)"
                % (retirees, len(ventes_brutes),
                   100 * retirees / max(len(ventes_brutes), 1)))
        journal("Ventes retenues : %d" % len(ventes))
        if not ventes:
            raise SystemExit("ERREUR : aucune vente retenue, rien a publier.")

        # ---------------- Etape 2 : les contours ----------------------------
        journal("Contours des communes...")
        geojsons = {}
        for dep in DEPARTEMENTS:
            if options.source_locale:
                geojsons[dep] = charger_geojson_local(options.source_locale, dep)
            else:
                destination = os.path.join(dossier_temporaire, "communes-%s.geojson" % dep)
                if telecharger(URL_CONTOURS[dep], destination):
                    with open(destination, encoding="utf-8") as flux:
                        geojsons[dep] = json.load(flux)
                else:
                    raise SystemExit("ERREUR : contours du departement %s indisponibles." % dep)
        contours, adjacence, centroides = construire_contours(geojsons)
        journal("  %d communes, %d ont au moins un voisin"
                % (len(contours["features"]), len(adjacence)))

        # Les noms de communes viennent d'abord des ventes. Mais une commune ou
        # aucune vente n'a ete retenue n'y figure pas : sans ce complement, elle
        # s'affichait avec son code INSEE brut (« 30074 » au lieu de « Sabran »),
        # et remontait en tete de liste puisque les chiffres se classent avant
        # les lettres. Le fichier des contours, lui, porte le nom officiel.
        complements = 0
        for geojson in geojsons.values():
            for entite in geojson["features"]:
                proprietes = entite["properties"]
                code = proprietes["code"]
                if code not in noms_communes and proprietes.get("nom"):
                    noms_communes[code] = proprietes["nom"]
                    complements += 1
        if complements:
            journal("  %d commune(s) sans vente nommee(s) d'apres les contours" % complements)

        # ---------------- Etape 3 : ecriture --------------------------------
        journal("Ecriture dans %s ..." % options.sortie)
        meta = construire_sorties(ventes, contours, adjacence, centroides,
                                  noms_communes, millesimes, options.sortie)
        for dep, infos in sorted(meta["departements"].items()):
            journal("  %-18s %7d ventes, mediane %5d EUR/m2"
                    % (DEPARTEMENTS[dep]["nom"], infos["nb_ventes"], infos["prix_m2_median"]))

        os.makedirs(options.sortie, exist_ok=True)
        with open(os.path.join(options.sortie, "_rapport.txt"), "w", encoding="utf-8") as flux:
            flux.write("\n".join(RAPPORT) + "\n")
        journal("Termine.")
    finally:
        shutil.rmtree(dossier_temporaire, ignore_errors=True)


if __name__ == "__main__":
    main()
