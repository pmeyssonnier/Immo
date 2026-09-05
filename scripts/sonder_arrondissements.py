#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Sonde : ou trouver les contours des arrondissements de Marseille et Lyon ?

Ce programme est JETABLE. Il n'ecrit rien dans data/, ne publie rien, ne commit
rien : il essaie plusieurs sources et imprime ce qu'il constate.

LE PROBLEME. DVF enregistre les ventes des grandes villes PAR ARRONDISSEMENT
(13201..13216, 69381..69389), mais la source des contours du projet --
france-geojson -- ne connait que la commune entiere (13055, 69123). Resultat :
Marseille et Lyon sont grises sur la carte d'ensemble, « donnees insuffisantes »,
alors qu'elles portent 7 980 ventes. Verifie : france-geojson n'a d'arrondissements
NULLE PART, ni par departement ni dans son fichier national de 35 228 entites.

POURQUOI UNE SONDE. L'environnement de developpement ne joint que GitHub. Impossible
d'y tester data.gouv.fr, l'API Geo ou OpenDataSoft. Le robot, lui, a le reseau
complet -- il telecharge deja DVF depuis files.data.gouv.fr. On mesure donc la-bas.

CE QU'UNE SOURCE DOIT PROUVER pour etre retenue :
  1. repondre sans clef ni compte ;
  2. porter EXACTEMENT les 25 codes que DVF emploie -- une source qui nomme les
     arrondissements autrement est inutilisable pour la jointure ;
  3. annoncer une licence libre ;
  4. tenir dans le budget d'affichage : les contours sont telecharges au
     DEMARRAGE du site, ils pesent 0,84 Mo compresse aujourd'hui.

Usage :
    python3 scripts/sonder_arrondissements.py
"""

import gzip
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import preparer_donnees as prep  # noqa: E402  (pour la simplification des traces)

DELAI = 90
ENTETES = {"User-Agent": "immo-gard-ardeche-sonde-arrondissements/1.0"}

# Les 25 codes que DVF emploie reellement. Ils viennent des donnees publiees,
# pas d'une supposition : ce sont les fichiers de data/ventes/13 et 69.
MARSEILLE = ["132%02d" % n for n in range(1, 17)]
LYON = ["693%02d" % n for n in range(81, 90)]
ATTENDUS = set(MARSEILLE + LYON)


def journal(m):
    print(m, flush=True)


def lire(url, delai=DELAI):
    """Va chercher une URL et rapporte, sans jamais lever d'exception."""
    debut = time.time()
    try:
        requete = urllib.request.Request(url, headers=ENTETES)
        with urllib.request.urlopen(requete, timeout=delai) as reponse:
            corps = reponse.read()
            if reponse.headers.get("Content-Encoding") == "gzip":
                corps = gzip.decompress(corps)
            return {"statut": reponse.status, "corps": corps, "erreur": None,
                    "duree": time.time() - debut,
                    "type": reponse.headers.get("Content-Type", "")}
    except urllib.error.HTTPError as e:
        return {"statut": e.code, "corps": b"", "erreur": "HTTP %s" % e.code,
                "duree": time.time() - debut, "type": ""}
    except Exception as e:
        return {"statut": None, "corps": b"", "erreur": "%s: %s" % (type(e).__name__, e),
                "duree": time.time() - debut, "type": ""}


def codes_du_geojson(charge, champs_vus=None):
    """Recupere les codes, quel que soit le nom du champ selon la source."""
    codes = {}
    if champs_vus is None:
        champs_vus = set()
    entites = charge.get("features", charge if isinstance(charge, list) else [])
    for e in entites:
        props = e.get("properties", e) or {}
        for cle in ("code", "com_arm_code", "insee_arm", "code_insee", "insee_code",
                    "arrondissement_municipal_code", "com_code"):
            valeur = props.get(cle)
            if isinstance(valeur, list) and valeur:
                valeur = valeur[0]
            if valeur and str(valeur) in ATTENDUS:
                codes[str(valeur)] = e
                champs_vus.add(cle)
                break
    return codes


def poids_apres_simplification(entites):
    """Ce que pesera VRAIMENT le fichier publie, apres allegement des traces.

    On reutilise la simplification du robot (EPSILON_DP, DECIMALES_CONTOURS)
    plutot que de comparer des poids bruts qui ne veulent rien dire.
    """
    allegees = []
    for e in entites:
        anneaux = []
        for anneau in prep.parcourir_anneaux(e.get("geometry") or {}):
            propre = prep.nettoyer_anneau(anneau)
            if propre:
                anneaux.append(propre)
        allegees.append(anneaux)
    brut = json.dumps(allegees, separators=(",", ":")).encode()
    return len(brut), len(gzip.compress(brut, 9))


# --------------------------------------------------------------------------
# Les sources candidates
# --------------------------------------------------------------------------

CANDIDATES = [
    ("OpenDataSoft FILTRE sur com_arm_code -- 292 Mo -> ?",
     "https://public.opendatasoft.com/api/explore/v2.1/catalog/datasets/georef-france-commune-arrondissement-municipal/exports/geojson?limit=-1&where=com_arm_code%20in%20%28%2213201%22%2C%2213202%22%2C%2213203%22%2C%2213204%22%2C%2213205%22%2C%2213206%22%2C%2213207%22%2C%2213208%22%2C%2213209%22%2C%2213210%22%2C%2213211%22%2C%2213212%22%2C%2213213%22%2C%2213214%22%2C%2213215%22%2C%2213216%22%2C%2269381%22%2C%2269382%22%2C%2269383%22%2C%2269384%22%2C%2269385%22%2C%2269386%22%2C%2269387%22%2C%2269388%22%2C%2269389%22%29",
     "Licence Ouverte (Etalab)"),

    ("OpenDataSoft FILTRE sur com_code -- 292 Mo -> ?",
     "https://public.opendatasoft.com/api/explore/v2.1/catalog/datasets/georef-france-commune-arrondissement-municipal/exports/geojson?limit=-1&where=com_code%20in%20%28%2213201%22%2C%2213202%22%2C%2213203%22%2C%2213204%22%2C%2213205%22%2C%2213206%22%2C%2213207%22%2C%2213208%22%2C%2213209%22%2C%2213210%22%2C%2213211%22%2C%2213212%22%2C%2213213%22%2C%2213214%22%2C%2213215%22%2C%2213216%22%2C%2269381%22%2C%2269382%22%2C%2269383%22%2C%2269384%22%2C%2269385%22%2C%2269386%22%2C%2269387%22%2C%2269388%22%2C%2269389%22%29",
     "Licence Ouverte (Etalab)"),
    ("API Geo (etat) -- arrondissements comme communes ?",
     "https://geo.api.gouv.fr/communes/13201?fields=code,nom,contour&format=geojson",
     "Licence Ouverte (Etalab), a confirmer"),

    ("OpenDataSoft -- georef-france-commune-arrondissement-municipal",
     "https://public.opendatasoft.com/api/explore/v2.1/catalog/datasets/"
     "georef-france-commune-arrondissement-municipal/exports/geojson?limit=-1",
     "Licence Ouverte (Etalab), a confirmer"),

    ("data.gouv.fr -- recherche « arrondissements municipaux » dans le catalogue",
     "https://www.data.gouv.fr/api/1/datasets/?q=arrondissements+municipaux+contours&page_size=5",
     "variable selon le jeu"),

    ("France-geojson -- temoin negatif (on sait qu'il n'en a pas)",
     "https://raw.githubusercontent.com/gregoiredavid/france-geojson/master/"
     "departements/13-bouches-du-rhone/communes-13-bouches-du-rhone.geojson",
     "Licence Ouverte, derive IGN"),
]


def essayer(nom, url, licence):
    journal("\n" + "-" * 74)
    journal("SOURCE : %s" % nom)
    journal("  %s" % url[:110])
    reponse = lire(url)
    journal("  statut %s  %s  %.1f s  %.2f Mo"
            % (reponse["statut"], reponse["type"][:40], reponse["duree"],
               len(reponse["corps"]) / 1e6))
    if reponse["erreur"]:
        journal("  -> INEXPLOITABLE : %s" % reponse["erreur"])
        return None
    try:
        charge = json.loads(reponse["corps"].decode("utf-8"))
    except Exception as e:
        journal("  -> reponse illisible : %s" % e)
        return None

    # Le catalogue data.gouv.fr ne renvoie pas des contours mais des fiches :
    # on imprime les pistes plutot que de chercher des codes dedans.
    if "data.gouv.fr/api" in url:
        for jeu in (charge.get("data") or [])[:5]:
            lic = (jeu.get("license") or "non declaree")
            journal("    - %-58.58s licence : %s" % (jeu.get("title", "?"), lic))
            for r in (jeu.get("resources") or [])[:3]:
                if "json" in (r.get("format") or "").lower():
                    journal("        %s  ->  %s" % (r.get("format"), (r.get("url") or "")[:90]))
        return None

    champs_vus = set()
    trouves = codes_du_geojson(charge, champs_vus)
    if champs_vus:
        journal("  champ portant le code : %s" % ", ".join(sorted(champs_vus)))
    manquants = sorted(ATTENDUS - set(trouves))
    journal("  codes DVF trouves : %d / 25" % len(trouves))
    if manquants:
        journal("  MANQUANTS : %s" % ", ".join(manquants[:8])
                + (" ..." if len(manquants) > 8 else ""))
    if not trouves:
        journal("  -> inutilisable : aucun des codes que DVF emploie")
        return None

    brut, compresse = poids_apres_simplification(list(trouves.values()))
    journal("  poids apres simplification du robot : %d octets bruts, %d compresses"
            % (brut, compresse))
    journal("  licence annoncee : %s" % licence)
    if len(trouves) == 25:
        journal("  -> CANDIDATE RETENUE : les 25 arrondissements y sont.")
    else:
        journal("  -> incomplete, a ecarter sauf si rien d'autre ne marche")
    return trouves


def reproduire_le_chemin_du_robot():
    """Rejoue EXACTEMENT ce que fait le robot, qui lui a echoue.

    La sonde recevait les 25 polygones ; le robot n'en a recu aucun sur la meme
    URL. La difference ne peut venir que du chemin emprunte : telecharger() a ses
    propres en-tetes, ecrit dans un fichier, verifie la taille annoncee. On rejoue
    donc ce chemin-la et on imprime ce qui arrive vraiment.
    """
    import tempfile
    journal("\n" + "=" * 74)
    journal("REPRODUCTION DU CHEMIN DU ROBOT (telecharger + json.load)")
    journal("=" * 74)
    journal("  URL du robot, longueur %d :" % len(prep.URL_ARRONDISSEMENTS))
    journal("  %s" % prep.URL_ARRONDISSEMENTS[:150])
    journal("  en-tetes du robot : %s" % prep.ENTETES_HTTP)

    with tempfile.TemporaryDirectory() as d:
        cible = os.path.join(d, "arrondissements.geojson")
        ok = prep.telecharger(prep.URL_ARRONDISSEMENTS, cible)
        journal("  telecharger() -> %s" % ok)
        if not ok or not os.path.exists(cible):
            journal("  -> le telechargement lui-meme echoue.")
            return
        taille = os.path.getsize(cible)
        journal("  fichier recu : %d octets" % taille)
        with open(cible, "rb") as flux:
            debut = flux.read(600)
        journal("  600 premiers octets :")
        journal("    %r" % debut)
        try:
            with open(cible, encoding="utf-8") as flux:
                charge = json.load(flux)
        except Exception as e:
            journal("  -> JSON illisible : %s" % e)
            return
        if isinstance(charge, dict):
            journal("  clefs de premier niveau : %s" % sorted(charge)[:10])
            entites = charge.get("features")
            journal("  features : %s" % (len(entites) if entites is not None else "ABSENT"))
            if entites:
                journal("  proprietes de la 1re : %s"
                        % sorted((entites[0].get("properties") or {}))[:12])
        trouves = codes_du_geojson(charge)
        journal("  codes DVF retrouves : %d / 25" % len(trouves))


def main():
    journal("SONDE ARRONDISSEMENTS -- aucune ecriture dans data/, aucun commit")
    journal("Cherche les contours de %d arrondissements (Marseille 16, Lyon 9)"
            % len(ATTENDUS))
    journal("Budget a respecter : les contours pesent 0,84 Mo compresse au demarrage.")

    retenues = 0
    for nom, url, licence in CANDIDATES:
        if essayer(nom, url, licence):
            retenues += 1

    reproduire_le_chemin_du_robot()

    journal("\n" + "=" * 74)
    journal("BILAN : %d source(s) exploitable(s)" % retenues)
    if not retenues:
        journal("Aucune source ne convient en l'etat. L'integration n'a pas lieu ;")
        journal("il faudra chercher ailleurs plutot que bricoler des contours faux.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
