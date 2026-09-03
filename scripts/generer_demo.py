#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Fabrique un jeu de donnees de DEMONSTRATION, a taille reelle.

A quoi ca sert ? A construire et tester le site AVANT d'avoir les vraies
donnees DVF. On utilise les VRAIS contours des 692 communes du Gard et de
l'Ardeche, mais des ventes INVENTEES.

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

# Quelques villes reelles a qui on donne beaucoup de ventes, pour eprouver
# l'affichage dense (regroupement des marqueurs, fluidite de la carte).
GRANDES_VILLES = {
    "30189": 3000,  # Nimes
    "30007": 900,   # Ales
    "30032": 420,   # Bagnols-sur-Ceze
    "30258": 400,   # Villeneuve-les-Avignon
    "30341": 380,   # Vauvert
    "07010": 520,   # Annonay
    "07019": 480,   # Aubenas
    "07186": 300,   # Privas
    "07204": 280,   # Saint-Peray
    "07348": 260,   # Tournon-sur-Rhone
}


def telecharger_contours():
    geojsons = {}
    for dep, url in prep.URL_CONTOURS.items():
        print("Contours %s ..." % dep, flush=True)
        with urllib.request.urlopen(url, timeout=180) as reponse:
            geojsons[dep] = json.loads(reponse.read().decode("utf-8"))
    return geojsons


def inventer_ventes(centroides, noms, alea):
    ventes = []
    for code, (lat, lon) in centroides.items():
        dep = code[:2]
        # combien de ventes dans cette commune ?
        if code in GRANDES_VILLES:
            nombre = GRANDES_VILLES[code]
        else:
            tirage = alea.random()
            if tirage < 0.06:
                nombre = alea.randint(0, 4)      # village quasi sans transaction
            elif tirage < 0.75:
                nombre = alea.randint(5, 45)
            else:
                nombre = alea.randint(45, 160)

        # niveau de prix propre a la commune (le Gard est un peu plus cher)
        base = alea.lognormvariate(7.55 if dep == "30" else 7.38, 0.19)
        base = max(900.0, min(3600.0, base))

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
