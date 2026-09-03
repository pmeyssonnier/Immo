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
import re
import struct
import sys
import threading
import unittest
import urllib.request
import zlib
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

RACINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(RACINE, "scripts"))

SIGNATURE_PNG = b"\x89PNG\r\n\x1a\n"


def entete_png(octets):
    """Lit l'en-tete d'un PNG sans bibliotheque d'images.

    Le format est fige : 8 octets de signature, puis 4 octets de longueur de
    bloc, puis les 4 lettres "IHDR". Les donnees utiles commencent donc a la
    position 16 : largeur (4 octets), hauteur (4 octets), profondeur, type de
    couleur, compression, filtre, entrelacement -- tous en gros-boutiste.
    Personne ne devine ces decalages : d'ou ce commentaire.
    """
    if not octets.startswith(SIGNATURE_PNG):
        raise ValueError("ce fichier n'est pas un PNG")
    largeur, hauteur, profondeur, type_couleur, _compression, _filtre, entrelacement = \
        struct.unpack(">IIBBBBB", octets[16:29])
    return largeur, hauteur, profondeur, type_couleur, entrelacement


def pixel_haut_gauche(octets):
    """Renvoie le (R, V, B, A) du pixel en haut a gauche, sans bibliotheque.

    Astuce qui rend cela simple : sur la PREMIERE ligne d'une image, le pixel
    du dessus et celui de gauche sont consideres comme nuls. Les cinq filtres
    du format PNG predisent alors tous zero, quel que soit celui qui a ete
    choisi. La valeur brute lue est donc directement la vraie couleur.
    """
    _largeur, _hauteur, profondeur, type_couleur, entrelacement = entete_png(octets)
    if profondeur != 8 or entrelacement != 0 or type_couleur not in (2, 6):
        raise ValueError("attendu : 8 bits, RVB ou RVBA, non entrelace")

    # parcours des blocs : longueur (4), type (4), donnees, controle (4)
    donnees, position = b"", 8
    while position < len(octets):
        longueur = struct.unpack(">I", octets[position:position + 4])[0]
        type_bloc = octets[position + 4:position + 8]
        if type_bloc == b"IDAT":
            donnees += octets[position + 8:position + 8 + longueur]
        elif type_bloc == b"IEND":
            break
        position += 12 + longueur

    brut = zlib.decompress(donnees)
    # brut[0] = numero du filtre de la ligne, puis les octets du premier pixel.
    # Type 2 = RVB (pas de canal alpha du tout) : on complete par une opacite
    # totale, puisque c'est exactement ce que cela signifie.
    if type_couleur == 2:
        return tuple(brut[1:4]) + (255,)
    return tuple(brut[1:5])


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

    @staticmethod
    def chemins_de_l_entete(page):
        """Tous les href/src declares avant <body>."""
        entete = page.lower().split("<body")[0]
        return re.findall(r'(?:href|src)="([^"]+)"', entete)

    def test_page_et_ressources(self):
        page = self.obtenir("index.html").decode("utf-8")
        self.assertIn("Immo", page)
        self.assertIn('src="vendor/leaflet/leaflet.js"', page)

        # Rien dans l'en-tete ne doit venir de l'exterieur : ni bibliotheque
        # hebergee ailleurs, ni chemin absolu. Un chemin commencant par une
        # barre oblique viserait la racine du domaine et non notre sous-dossier
        # -- l'erreur silencieuse classique de ce genre de site.
        for chemin in self.chemins_de_l_entete(page):
            self.assertFalse(
                chemin.startswith(("http:", "https:", "//", "/")),
                "ressource externe ou chemin absolu dans l'en-tete : " + chemin)

        for ressource in ["css/style.css", "js/app.js", "js/estimation.js",
                          "vendor/leaflet/leaflet.js", "vendor/leaflet/leaflet.css",
                          "vendor/leaflet.markercluster/leaflet.markercluster.js",
                          "manifest.json", "icones/icone.svg",
                          "icones/apple-touch-icon.png", "icones/icone-512.png"]:
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

    def test_icones_declarees_dans_la_page(self):
        """Sans ces balises, le telephone fabrique une vignette floue de la page."""
        page = self.obtenir("index.html").decode("utf-8")
        entete = page.lower().split("<body")[0]
        for attendu in ['rel="icon"', 'rel="apple-touch-icon"',
                        'rel="manifest"', 'name="theme-color"']:
            self.assertIn(attendu, entete, "manquant dans l'en-tete : " + attendu)

        # chaque icone declaree doit exister reellement
        for chemin in self.chemins_de_l_entete(page):
            if chemin.startswith("icones/") or chemin == "manifest.json":
                self.assertGreater(len(self.obtenir(chemin)), 50, chemin + " est vide")

    def test_manifeste(self):
        manifeste = self.json("manifest.json")
        for cle in ["name", "short_name", "start_url", "scope", "display",
                    "background_color", "theme_color", "icons"]:
            self.assertIn(cle, manifeste, "manifest.json : champ '%s' manquant" % cle)

        # decision produit verrouillee par un test
        self.assertEqual(manifeste["short_name"], "Ventes DVF")

        # site publie dans un sous-dossier : jamais de chemin absolu
        for cle in ("start_url", "scope"):
            self.assertFalse(manifeste[cle].startswith("/"),
                             "%s absolu : le raccourci ouvrirait la mauvaise adresse" % cle)

        for icone in manifeste["icons"]:
            self.assertFalse(icone["src"].startswith("/"), icone["src"] + " est absolu")
            octets = self.obtenir(icone["src"])
            largeur, hauteur = entete_png(octets)[:2]
            # attrape la faute classique : annoncer 512x512 et livrer un 192
            self.assertEqual("%dx%d" % (largeur, hauteur), icone["sizes"],
                             "%s fait %dx%d mais est annonce %s"
                             % (icone["src"], largeur, hauteur, icone["sizes"]))

        maskables = [i for i in manifeste["icons"] if "maskable" in i.get("purpose", "")]
        self.assertTrue(maskables, "sans icone 'maskable', Android cerne l'icone de blanc")
        self.assertGreaterEqual(int(maskables[0]["sizes"].split("x")[0]), 192)

    def test_icones_plein_cadre_pour_les_telephones(self):
        """iOS ne gere pas la transparence : il remplit le vide avec du NOIR.

        Le fichier destine a iOS doit donc couvrir tout le carre, sans un seul
        pixel transparent -- sinon les coins arrondis deviennent des coins noirs
        baveux. Meme exigence pour l'icone adaptative d'Android.
        Verifier la couleur du pixel du coin prouve les trois choses a la fois :
        plein cadre, opacite totale, et bonne couleur de marque.
        """
        BLEU_DE_MARQUE = (0x1f, 0x4e, 0x79, 255)
        SANS_CANAL_ALPHA = 2          # type de couleur PNG : RVB seul
        AVEC_CANAL_ALPHA = 6          # RVBA

        for fichier in ("icones/apple-touch-icon.png", "icones/icone-maskable-512.png"):
            octets = self.obtenir(fichier)
            # Garantie la plus forte possible : le fichier n'a meme pas de canal
            # alpha, la transparence n'y est donc pas representable.
            self.assertEqual(entete_png(octets)[3], SANS_CANAL_ALPHA,
                             fichier + " : ce fichier ne doit avoir aucun canal alpha")
            self.assertEqual(pixel_haut_gauche(octets), BLEU_DE_MARQUE,
                             fichier + " : le coin devrait etre du bleu de marque")

        # a l'inverse, les icones de navigateur ont bien des coins arrondis
        octets = self.obtenir("icones/icone-512.png")
        self.assertEqual(entete_png(octets)[3], AVEC_CANAL_ALPHA)
        self.assertEqual(pixel_haut_gauche(octets)[3], 0,
                         "icone-512.png : le coin devrait etre transparent")

    def test_liste_des_departements_identique_des_deux_cotes(self):
        """Le script de preparation et le site doivent couvrir les MEMES
        departements, dans le MEME ordre.

        Ce test existe a cause d'un vrai piege : en JavaScript, les cles d'objet
        qui ressemblent a des entiers ("11", "26"...) sont parcourues en premier,
        avant les autres. Ecrite comme un objet, la liste affichait donc l'Aude
        et la Drome avant les Alpes-Maritimes et l'Ardeche, sans que rien ne
        signale l'anomalie. D'ou la liste ordonnee cote JavaScript, et ce test.
        """
        import preparer_donnees  # le script vit dans scripts/

        config = open(os.path.join(RACINE, "js", "config.js"), encoding="utf-8").read()
        bloc = config.split("DEPARTEMENTS: [")[1].split("]")[0]
        cote_site = re.findall(r'code:\s*"(\d{2})"', bloc)
        noms_site = re.findall(r'nom:\s*"([^"]+)"', bloc)
        cote_script = list(preparer_donnees.DEPARTEMENTS)

        self.assertEqual(cote_site, cote_script,
                         "js/config.js et scripts/preparer_donnees.py ne couvrent pas "
                         "les memes departements, ou pas dans le meme ordre")
        self.assertEqual(cote_site, sorted(cote_site),
                         "les departements doivent etre ranges par numero croissant")
        self.assertEqual(
            noms_site,
            [preparer_donnees.DEPARTEMENTS[c]["nom"] for c in cote_script],
            "les noms de departements different entre le site et le script")

    def test_extension_json_pour_les_contours(self):
        """GitHub Pages ne compresse pas les fichiers .geojson : 4x plus lourd."""
        self.assertTrue(os.path.exists(os.path.join(RACINE, "data", "communes-geo.json")))
        self.assertFalse(os.path.exists(os.path.join(RACINE, "data", "communes-geo.geojson")),
                         "renommer en .json : sinon le fichier est servi non compresse")


if __name__ == "__main__":
    unittest.main()
