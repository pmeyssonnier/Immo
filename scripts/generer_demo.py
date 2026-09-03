#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Fabrique un jeu de donnees de DEMONSTRATION, a taille reelle.

A quoi ca sert ? A construire et tester le site AVANT d'avoir les vraies
donnees DVF. On utilise les VRAIS contours des communes des departements
couverts, mais des ventes INVENTEES.

/!\\ Les prix produits ici sont FICTIFS. Le fichier meta.json porte le drapeau
"demonstration": true, et le site affiche alors un bandeau rouge d'avertissement.
Le workflow GitHub remplacera ces donnees par les vraies.

Utilisation :  python scripts/generer_demo.py --sortie data
"""

import argparse
import json
import os
import random
import sys
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import preparer_donnees as prep  # noqa: E402

# Dans chaque departement, quelques communes recoivent beaucoup de ventes, pour
# eprouver l'affichage dense (regroupement des marqueurs, fluidite de la carte).
# On les tire au sort avec une graine fixe plutot que de coder une liste de
# villes : ainsi, ajouter un departement ne demande rien de plus.
NB_GRANDES_VILLES_PAR_DEPARTEMENT = 3
VENTES_GRANDE_VILLE = (700, 3000)


def designer_grandes_villes(codes_par_departement, alea):
    grandes = {}
    for codes in codes_par_departement.values():
        for code in alea.sample(sorted(codes),
                                min(NB_GRANDES_VILLES_PAR_DEPARTEMENT, len(codes))):
            grandes[code] = alea.randint(*VENTES_GRANDE_VILLE)
    return grandes


# Logarithme du prix median au m2 vise, par departement. Valeurs plausibles,
# uniquement destinees a produire un jeu de demonstration realiste.
NIVEAU_PRIX = {
    "04": 7.55,   # Alpes-de-Haute-Provence
    "05": 7.80,   # Hautes-Alpes
    "06": 8.55,   # Alpes-Maritimes : environ 5 200 EUR/m2
    "07": 7.45,   # Ardeche
    "11": 7.40,   # Aude
    "13": 8.30,   # Bouches-du-Rhone
    "26": 7.65,   # Drome
    "30": 7.75,   # Gard
    "34": 7.95,   # Herault
    "83": 8.25,   # Var
    "84": 7.90,   # Vaucluse
}


def telecharger_contours():
    geojsons = {}
    for dep, url in prep.URL_CONTOURS.items():
        print("Contours %s ..." % dep, flush=True)
        with urllib.request.urlopen(url, timeout=180) as reponse:
            geojsons[dep] = json.loads(reponse.read().decode("utf-8"))
    return geojsons


def inventer_ventes(centroides, noms, alea):
    codes_par_departement = {}
    for code in centroides:
        codes_par_departement.setdefault(code[:2], set()).add(code)
    grandes_villes = designer_grandes_villes(codes_par_departement, alea)

    ventes = []
    for code, (lat, lon) in centroides.items():
        dep = code[:2]
        # combien de ventes dans cette commune ?
        if code in grandes_villes:
            nombre = grandes_villes[code]
        else:
            tirage = alea.random()
            if tirage < 0.06:
                nombre = alea.randint(0, 4)      # village quasi sans transaction
            elif tirage < 0.75:
                nombre = alea.randint(5, 45)
            else:
                nombre = alea.randint(45, 160)

        # Niveau de prix propre a la commune. Le parametre depend du
        # departement : sans cela, on ne testerait jamais l'echelle de couleurs
        # sur un ecart aussi grand que celui entre l'Ardeche et la Cote d'Azur.
        base = alea.lognormvariate(NIVEAU_PRIX.get(dep, 7.45), 0.22)
        base = max(700.0, min(14000.0, base))

        for _ in range(nombre):
            t = alea.randint(0, 71)
            # les prix montent doucement avec le temps
            niveau = base * (1 + 0.022 * (t - 36) / 12.0)
            prix_m2 = niveau * alea.lognormvariate(0.0, 0.21)
            surface = max(30, min(420, int(alea.lognormvariate(4.72, 0.30))))
            terrain = 0 if alea.random() < 0.12 else int(alea.lognormvariate(6.4, 1.0))
            terrain = min(terrain, 40000)
            prix = int(round(prix_m2 * surface / 1000.0) * 1000)
            if not (prep.PRIX_MIN <= prix <= prep.PRIX_MAX):
                continue
            ventes.append({
                "code_commune": code, "nom_commune": noms[code], "dep": dep,
                "t": t, "prix": prix, "sbati": surface, "sterr": terrain,
                "pieces": max(1, min(12, round(surface / 24) + alea.randint(-1, 1))),
                "lat": round(lat + alea.gauss(0, 0.011), 5),
                "lon": round(lon + alea.gauss(0, 0.014), 5),
                "adresse": "%d %s" % (alea.randint(1, 90),
                                      alea.choice(["RUE DES ECOLES", "AVENUE DE LA GARE",
                                                   "CHEMIN DES VIGNES", "ROUTE DE NIMES",
                                                   "PLACE DU MARCHE", "IMPASSE DU MOULIN"])),
                "prix_m2": prix / surface,
            })
    return ventes


def main():
    analyseur = argparse.ArgumentParser(description=__doc__)
    analyseur.add_argument("--sortie", default="data")
    options = analyseur.parse_args()

    geojsons = telecharger_contours()
    noms = {e["properties"]["code"]: e["properties"]["nom"]
            for geojson in geojsons.values() for e in geojson["features"]}

    print("Simplification des contours ...", flush=True)
    contours, adjacence, centroides = prep.construire_contours(geojsons)

    alea = random.Random(20260903)   # graine fixe : resultat reproductible
    ventes = inventer_ventes(centroides, noms, alea)
    ventes, retirees = prep.filtrer_aberrations(ventes)
    print("Ventes inventees : %d (%d retirees par le filtre)" % (len(ventes), retirees))

    meta = prep.construire_sorties(ventes, contours, adjacence, centroides, noms,
                                   ["DEMONSTRATION"], options.sortie)
    meta["demonstration"] = True
    prep.ecrire_json(os.path.join(options.sortie, "meta.json"), meta)
    print("Jeu de DEMONSTRATION ecrit dans %s (prix fictifs)." % options.sortie)


if __name__ == "__main__":
    main()
