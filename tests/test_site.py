# -*- coding: utf-8 -*-
"""Test de fumee : le site est-il servi correctement et ses donnees sont-elles lisibles ?

Ce test ne demande aucun navigateur : il demarre un petit serveur web, puis
telecharge chaque fichier comme le ferait le navigateur et verifie qu'il est
complet et coherent. Il tourne donc dans l'integration continue.

Pour la verification visuelle (carte, clics, estimation), voir
tests/verification_navigateur.mjs.
"""

import json
import os
import threading
import unittest
import urllib.request
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

RACINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class TestSite(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        gestionnaire = partial(SimpleHTTPRequestHandler, directory=RACINE)
        cls.serveur = ThreadingHTTPServer(("127.0.0.1", 0), gestionnaire)
        cls.base = "http://127.0.0.1:%d/" % cls.serveur.server_address[1]
        cls.fil = threading.Thread(target=cls.serveur.serve_forever, daemon=True)
        cls.fil.start()

    @classmethod
    def tearDownClass(cls):
        cls.serveur.shutdown()
        cls.serveur.server_close()

    def obtenir(self, chemin):
        with urllib.request.urlopen(self.base + chemin, timeout=30) as reponse:
            self.assertEqual(reponse.status, 200, chemin + " est introuvable")
            return reponse.read()

    def json(self, chemin):
        return json.loads(self.obtenir(chemin).decode("utf-8"))

    def test_page_et_ressources(self):
        page = self.obtenir("index.html").decode("utf-8")
        self.assertIn("Immo", page)
        # Leaflet doit venir du depot, jamais d'un CDN
        self.assertIn('src="vendor/leaflet/leaflet.js"', page)
        self.assertNotIn("cdn", page.lower().split("<body")[0].replace("cdnjs", "cdn"))
        for ressource in ["css/style.css", "js/app.js", "js/estimation.js",
                          "vendor/leaflet/leaflet.js", "vendor/leaflet/leaflet.css",
                          "vendor/leaflet.markercluster/leaflet.markercluster.js"]:
            self.assertGreater(len(self.obtenir(ressource)), 100, ressource + " est vide")

    def test_fichiers_de_donnees(self):
        meta = self.json("data/meta.json")
        for cle in ["millesimes", "mois_reference", "nb_ventes", "annee_origine",
                    "seuils_couleurs", "indice_prix", "departements"]:
            self.assertIn(cle, meta, "meta.json : champ '%s' manquant" % cle)
        self.assertGreater(meta["nb_ventes"], 0)

        communes = self.json("data/communes.json")
        self.assertIn("code", communes["champs"])
        self.assertGreater(len(communes["valeurs"]), 600, "il manque des communes")

        contours = self.json("data/communes-geo.json")
        self.assertEqual(contours["type"], "FeatureCollection")
        codes_geo = {e["properties"]["code"] for e in contours["features"]}
        codes_stats = {l[0] for l in communes["valeurs"]}
        self.assertTrue(codes_geo <= codes_stats,
                        "des communes ont un contour mais aucune ligne de statistiques")

        adjacence = self.json("data/adjacence.json")
        self.assertTrue(all(c in codes_stats for voisins in adjacence.values()
                            for c in voisins), "adjacence : code de commune inconnu")

    def test_un_fichier_de_ventes_est_lisible(self):
        communes = self.json("data/communes.json")
        indice_n = communes["champs"].index("n")
        ligne = max(communes["valeurs"], key=lambda l: l[indice_n])
        code, dep = ligne[0], ligne[2]
        ventes = self.json("data/ventes/%s/%s.json" % (dep, code))
        self.assertEqual(ventes["code"], code)
        self.assertEqual(len(ventes["ventes"]), ligne[indice_n])
        for champ in ["t", "prix", "sbati", "lat", "lon"]:
            self.assertIn(champ, ventes["champs"])
        premiere = dict(zip(ventes["champs"], ventes["ventes"][0]))
        self.assertGreater(premiere["prix"], 0)
        self.assertGreater(premiere["sbati"], 0)

    def test_extension_json_pour_les_contours(self):
        """GitHub Pages ne compresse pas les fichiers .geojson : 4x plus lourd."""
        self.assertTrue(os.path.exists(os.path.join(RACINE, "data", "communes-geo.json")))
        self.assertFalse(os.path.exists(os.path.join(RACINE, "data", "communes-geo.geojson")),
                         "renommer en .json : sinon le fichier est servi non compresse")


if __name__ == "__main__":
    unittest.main()
