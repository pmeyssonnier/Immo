#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Copie Leaflet dans le dossier vendor/ du projet.

Pourquoi ne pas utiliser un CDN ? Parce qu'une application qui depend d'un
serveur exterieur tombe en panne le jour ou ce serveur tombe. En figeant les
fichiers dans le depot, le site fonctionne pour toujours, tel quel.

A lancer une seule fois :  python scripts/vendoriser_leaflet.py
"""

import io
import os
import shutil
import tarfile
import urllib.request

RACINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

PAQUETS = [
    {
        "nom": "leaflet",
        "version": "1.9.4",
        "url": "https://registry.npmjs.org/leaflet/-/leaflet-1.9.4.tgz",
        "destination": "vendor/leaflet",
        "fichiers": ["dist/leaflet.js", "dist/leaflet.css"],
        "dossiers": ["dist/images"],
    },
    {
        "nom": "leaflet.markercluster",
        "version": "1.5.3",
        "url": "https://registry.npmjs.org/leaflet.markercluster/-/leaflet.markercluster-1.5.3.tgz",
        "destination": "vendor/leaflet.markercluster",
        "fichiers": ["dist/leaflet.markercluster.js", "dist/MarkerCluster.css",
                     "dist/MarkerCluster.Default.css"],
        "dossiers": [],
    },
]


def main():
    for paquet in PAQUETS:
        print("Telechargement de %s %s ..." % (paquet["nom"], paquet["version"]))
        with urllib.request.urlopen(paquet["url"], timeout=120) as reponse:
            archive = io.BytesIO(reponse.read())

        destination = os.path.join(RACINE, paquet["destination"])
        os.makedirs(destination, exist_ok=True)

        with tarfile.open(fileobj=archive, mode="r:gz") as tar:
            for membre in tar.getmembers():
                if not membre.isfile():
                    continue
                # les archives npm rangent tout sous "package/"
                relatif = membre.name.split("/", 1)[1] if "/" in membre.name else membre.name
                garde = relatif in paquet["fichiers"] or \
                    any(relatif.startswith(d + "/") for d in paquet["dossiers"])
                if not garde:
                    continue
                sous_chemin = relatif[len("dist/"):] if relatif.startswith("dist/") else relatif
                cible = os.path.join(destination, sous_chemin)
                os.makedirs(os.path.dirname(cible), exist_ok=True)
                with tar.extractfile(membre) as source, open(cible, "wb") as sortie:
                    shutil.copyfileobj(source, sortie)
                print("  -> %s/%s" % (paquet["destination"], sous_chemin))
    print("Termine. Leaflet est maintenant fige dans le depot.")


if __name__ == "__main__":
    main()
