# -*- coding: utf-8 -*-
"""Verifie que le nettoyage des donnees DVF fait bien ce qu'on attend.

Chaque test correspond a un piege reel du fichier DVF. Lancer avec :
    python -m unittest discover tests
"""

import csv
import datetime as dt
import json
import os
import random
import shutil
import sys
import tempfile
import threading
import unittest
from collections import defaultdict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

RACINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(RACINE, "scripts"))

import preparer_donnees as prep  # noqa: E402

FIXTURES = os.path.join(RACINE, "tests", "fixtures")


def charger_mutations():
    """Regroupe le CSV de test par id_mutation, comme le fait le vrai script."""
    groupes = defaultdict(list)
    with open(os.path.join(FIXTURES, "dvf_echantillon.csv"), encoding="utf-8") as flux:
        for ligne in csv.DictReader(flux):
            groupes[ligne["id_mutation"]].append(ligne)
    return groupes


class TestConsolidation(unittest.TestCase):
    """Une mutation = plusieurs lignes CSV. On verifie la fusion de ces lignes."""

    @classmethod
    def setUpClass(cls):
        cls.groupes = charger_mutations()

    def consolider(self, identifiant):
        compteurs = defaultdict(int)
        resultat = prep.consolider(self.groupes[identifiant], compteurs)
        return resultat, compteurs

    # ---- le piege numero 1 de DVF -----------------------------------------
    def test_valeur_fonciere_jamais_sommee(self):
        vente, _ = self.consolider("C1")
        self.assertIsNotNone(vente)
        self.assertEqual(vente["prix"], 240000, "le prix a ete somme sur les 3 lignes")
        self.assertEqual(vente["sbati"], 120)

    # ---- le piege numero 2 de DVF -----------------------------------------
    def test_terrain_dedoublonne_sur_une_meme_parcelle(self):
        vente, _ = self.consolider("C3")
        self.assertIsNotNone(vente)
        self.assertEqual(vente["sterr"], 800, "le terrain a ete compte plusieurs fois")

    def test_terrain_somme_sur_parcelles_distinctes(self):
        vente, _ = self.consolider("C4")
        self.assertIsNotNone(vente)
        self.assertEqual(vente["sterr"], 1400, "500 + 200 + 300 + 400 attendus")

    # ---- les regles de rejet ----------------------------------------------
    def test_R1_vefa_rejetee(self):
        vente, compteurs = self.consolider("C10")
        self.assertIsNone(vente)
        self.assertEqual(compteurs["R1_pas_une_vente"], 1)

    def test_R2_vente_mixte_rejetee(self):
        vente, compteurs = self.consolider("C2")
        self.assertIsNone(vente)
        self.assertEqual(compteurs["R2_vente_mixte"], 1)

    def test_R3_deux_maisons_rejetees(self):
        vente, compteurs = self.consolider("C5")
        self.assertIsNone(vente)
        self.assertEqual(compteurs["R3_plusieurs_maisons"], 1)

    def test_R4_lot_de_copropriete_rejete(self):
        vente, compteurs = self.consolider("C11")
        self.assertIsNone(vente)
        self.assertEqual(compteurs["R4_lots_copropriete"], 1)

    def test_R5_mutation_sur_deux_communes_rejetee(self):
        vente, compteurs = self.consolider("C9")
        self.assertIsNone(vente)
        self.assertEqual(compteurs["R5_plusieurs_communes"], 1)

    def test_R6_sans_coordonnees_rejetee(self):
        vente, compteurs = self.consolider("C12")
        self.assertIsNone(vente)
        self.assertEqual(compteurs["R6_sans_coordonnees"], 1)

    def test_R7_surface_absente_rejetee(self):
        vente, compteurs = self.consolider("C7")
        self.assertIsNone(vente)
        self.assertEqual(compteurs["R7_champs_manquants"], 1)

    def test_prix_nul_rejete(self):
        vente, compteurs = self.consolider("C6")
        self.assertIsNone(vente)
        self.assertEqual(compteurs["B_bornes_implausibles"], 1)

    def test_prix_au_m2_delirant_rejete(self):
        vente, compteurs = self.consolider("C8")   # 45 000 EUR/m2
        self.assertIsNone(vente)
        self.assertEqual(compteurs["B_bornes_implausibles"], 1)

    # ---- cas conserves ----------------------------------------------------
    def test_dependance_ne_disqualifie_pas(self):
        """Un garage vendu avec la maison ne doit pas faire rejeter la vente."""
        vente, _ = self.consolider("C13")
        self.assertIsNotNone(vente)
        self.assertEqual(vente["sbati"], 115, "la dependance ne compte pas dans le bati")

    def test_adresse_reconstituee(self):
        vente, _ = self.consolider("C1")
        self.assertEqual(vente["adresse"], "12 RUE DES LICES")

    def test_date_convertie_en_mois(self):
        vente, _ = self.consolider("C1")   # 2024-03 -> (2024-2020)*12 + 2
        self.assertEqual(vente["t"], 50)
        self.assertEqual(prep.annee_depuis_mois(vente["t"]), 2024)


class TestAberrations(unittest.TestCase):
    """L'etage MAD doit retirer les valeurs folles sans toucher aux ventes saines."""

    def test_vente_hors_marche_retiree(self):
        groupes = charger_mutations()
        compteurs = defaultdict(int)
        ventes = [v for v in (prep.consolider(l, compteurs) for l in groupes.values())
                  if v is not None]
        gardees, retirees = prep.filtrer_aberrations(ventes)
        prix_m2_gardes = [round(v["prix_m2"]) for v in gardees]
        self.assertEqual(retirees, 1, "seule la vente a 7500 EUR/m2 devait sauter")
        self.assertNotIn(7500, prix_m2_gardes)
        # les ventes ordinaires, elles, sont toutes conservees
        self.assertGreaterEqual(len(gardees), 18)

    def test_mad_resiste_aux_valeurs_extremes(self):
        """Une seule valeur delirante ne doit pas deplacer le seuil."""
        normal = [7.6, 7.61, 7.62, 7.63, 7.64]
        med_a, sigma_a = prep.seuil_mad(normal)
        med_b, sigma_b = prep.seuil_mad(normal + [99.0])
        self.assertAlmostEqual(med_a, med_b, places=1)
        self.assertLess(sigma_b, 1.0, "l'ecart-type classique aurait explose")


class TestPrixDuTerrain(unittest.TestCase):
    """Le prix du terrain doit resister au bruit enorme des donnees reelles.

    DVF ignore l'etat du bien : deux maisons identiques peuvent differer de
    100 000 EUR. Ce bruit ecrase le signal du terrain et faisait deraper une
    regression classique. D'ou Theil-Sen, et un seuil eleve de ventes.
    """

    @staticmethod
    def points(pente_reelle, n=400, bruit=0, aberrantes=0, graine=7):
        alea = random.Random(graine)
        points = []
        for i in range(n):
            terrain = 100 + (i * 1900) // n
            reste = pente_reelle * terrain + (alea.gauss(0, bruit) if bruit else 0)
            points.append((float(terrain), reste))
        for i in range(aberrantes):
            points.append((200.0 + i, 700000.0))
        return points

    def test_deduction_du_bati_avec_la_mediane_de_la_commune(self):
        ventes = [{"sterr": 500, "sbati": 100, "prix": 250000},
                  {"sterr": 0, "sbati": 90, "prix": 200000}]   # sans terrain : ignoree
        points = prep.points_terrain(ventes, 2000)
        self.assertEqual(len(points), 1)
        self.assertEqual(points[0], (500.0, 250000 - 2000 * 100))

    def test_terrain_plafonne(self):
        points = prep.points_terrain([{"sterr": 99999, "sbati": 100, "prix": 300000}], 2000)
        self.assertEqual(points[0][0], prep.TERRAIN_PLAFOND_REGRESSION)

    def test_retrouve_la_pente_sur_des_donnees_propres(self):
        self.assertAlmostEqual(
            prep.pente_theil_sen(self.points(25, n=3000), random.Random(1)), 25.0, places=0)

    def test_resiste_au_bruit_et_aux_aberrations_a_l_echelle_d_un_departement(self):
        """Le cas reel : gros bruit de qualite + quelques ventes hors norme."""
        pente = prep.pente_theil_sen(
            self.points(25, n=30000, bruit=60000, aberrantes=150), random.Random(1))
        self.assertIsNotNone(pente)
        self.assertTrue(20 <= pente <= 30,
                        "pente %s : l'estimateur n'a pas resiste au bruit" % pente)

    def test_stable_d_un_echantillon_a_l_autre(self):
        """C'est CE resultat qui justifie de ne calculer qu'au niveau departemental."""
        pentes = [prep.pente_theil_sen(
            self.points(25, n=20000, bruit=60000, graine=g), random.Random(1))
            for g in range(4)]
        self.assertLess(max(pentes) - min(pentes), 2.0,
                        "dispersion trop forte entre echantillons : %s" % pentes)

    def test_refuse_de_repondre_faute_de_ventes(self):
        """Une commune (quelques centaines de ventes) n'atteint jamais le seuil."""
        self.assertIsNone(prep.pente_theil_sen(self.points(25, n=5), random.Random(1)))
        self.assertIsNone(prep.pente_theil_sen(self.points(25, n=600), random.Random(1)),
                          "600 ventes : trop peu pour un chiffre credible")

    def test_une_pente_implausible_est_ecartee(self):
        """Mieux vaut ne rien dire que d'annoncer 0,5 ou 500 EUR/m2."""
        for pente_absurde in (-40, 0.2, 400):
            self.assertIsNone(
                prep.pente_theil_sen(self.points(pente_absurde, n=3000), random.Random(1)),
                "pente %s aurait du etre rejetee" % pente_absurde)

    def test_resultat_reproductible(self):
        """Graine fixe : deux executions doivent donner le meme chiffre."""
        points = self.points(25, n=12000, bruit=40000)
        self.assertEqual(prep.pente_theil_sen(points, random.Random(20260101)),
                         prep.pente_theil_sen(points, random.Random(20260101)))

    def test_le_seuil_reste_hors_de_portee_d_une_commune(self):
        """Garde-fou : ce seuil eleve est ce qui empeche un chiffre communal faux."""
        self.assertGreaterEqual(prep.MIN_VENTES_REGRESSION_TERRAIN, 2000)


class TestContours(unittest.TestCase):
    """La simplification ne doit PAS creer de fentes entre communes voisines."""

    @classmethod
    def setUpClass(cls):
        with open(os.path.join(FIXTURES, "communes_test.geojson"), encoding="utf-8") as flux:
            geojson = json.load(flux)
        par_dep = {}
        for dep in ("30", "07"):
            par_dep[dep] = {"type": "FeatureCollection", "features": [
                e for e in geojson["features"] if e["properties"]["code"].startswith(dep)]}
        cls.avant = geojson
        cls.contours, cls.adjacence, cls.centroides = prep.construire_contours(par_dep)

    def test_adjacence_deduite_des_sommets_partages(self):
        """Nimes et Ales partagent une frontiere : elles doivent etre voisines."""
        self.assertIn("30032", self.adjacence.get("30189", []))
        self.assertIn("30189", self.adjacence.get("30032", []))
        # Privas est isolee dans le jeu de test : aucun voisin
        self.assertNotIn("07186", self.adjacence)

    @staticmethod
    def sommets_par_commune(geojson):
        """Renvoie {code_commune: ensemble de ses sommets arrondis}."""
        resultat = {}
        for entite in geojson["features"]:
            code = entite["properties"]["code"]
            points = set()
            for anneau in prep.parcourir_anneaux(entite["geometry"]):
                for point in anneau:
                    points.add(prep.arrondir_point(tuple(point)))
            resultat[code] = points
        return resultat

    def test_frontiere_partagee_reste_identique_des_deux_cotes(self):
        """LE test qui garantit l'absence de fente blanche sur la carte.

        Un sommet partage par deux communes avant simplification doit se
        retrouver soit dans les DEUX apres, soit dans AUCUNE. S'il ne survivait
        que d'un cote, les deux contours divergeraient et la carte afficherait
        une fente.
        """
        avant = self.sommets_par_commune(self.avant)
        apres = self.sommets_par_commune(self.contours)

        partages_avant = avant["30189"] & avant["30032"]
        self.assertGreater(len(partages_avant), 20,
                           "le jeu de test doit contenir une vraie frontiere commune")

        survivants_ouest = partages_avant & apres["30189"]
        survivants_est = partages_avant & apres["30032"]
        self.assertEqual(survivants_ouest, survivants_est,
                         "des sommets de frontiere ont survecu d'un seul cote -> fente blanche")
        self.assertGreater(len(survivants_ouest), 2,
                           "la frontiere sinueuse doit conserver des sommets intermediaires")

    def test_aucun_sommet_invente(self):
        """La simplification ne fait que RETIRER des sommets, jamais en creer."""
        avant = self.sommets_par_commune(self.avant)
        apres = self.sommets_par_commune(self.contours)
        for code, points in apres.items():
            self.assertTrue(points <= avant[code], "sommets inventes dans %s" % code)

    def test_simplification_reduit_le_volume(self):
        avant = sum(len(a) for e in self.avant["features"]
                    for a in prep.parcourir_anneaux(e["geometry"]))
        apres = sum(len(a) for e in self.contours["features"]
                    for a in prep.parcourir_anneaux(e["geometry"]))
        self.assertLess(apres, avant)

    def test_centroide_dans_la_commune(self):
        lat, lon = self.centroides["30189"]
        self.assertTrue(4.30 < lon < 4.42 and 43.80 < lat < 43.88)


class TestChaineComplete(unittest.TestCase):
    """Bout en bout : le script produit-il des fichiers exploitables ?"""

    def test_generation_complete(self):
        sortie = tempfile.mkdtemp(prefix="immo-test-")
        argv = sys.argv
        sys.argv = ["preparer_donnees.py", "--source-locale", FIXTURES, "--sortie", sortie]
        try:
            prep.RAPPORT.clear()
            prep.main()
        finally:
            sys.argv = argv

        with open(os.path.join(sortie, "meta.json"), encoding="utf-8") as flux:
            meta = json.load(flux)
        self.assertGreater(meta["nb_ventes"], 15)
        self.assertIn("30", meta["departements"])

        with open(os.path.join(sortie, "communes.json"), encoding="utf-8") as flux:
            communes = json.load(flux)
        self.assertEqual(communes["champs"], prep.CHAMPS_COMMUNE)
        par_code = {l[0]: l for l in communes["valeurs"]}
        nimes = par_code["30189"]
        self.assertGreaterEqual(nimes[5], 15)             # nombre de ventes
        self.assertTrue(1400 < nimes[6] < 2600, "mediane EUR/m2 invraisemblable")

        # une commune sans assez de ventes n'est pas coloriee
        ales = par_code["30032"]
        self.assertIsNone(ales[6], "commune sans donnees : elle doit rester grise")
        # ... mais elle garde son NOM, pris dans les contours faute de vente.
        # Sans cela elle s'afficherait « 30032 » et se classerait avant les
        # communes dont le nom commence par une lettre.
        self.assertEqual(ales[1], "Alès",
                         "une commune sans vente doit quand meme etre nommee")

        # les ventes d'une commune sont dans leur propre fichier
        chemin = os.path.join(sortie, "ventes", "30", "30189.json")
        self.assertTrue(os.path.exists(chemin))
        with open(chemin, encoding="utf-8") as flux:
            ventes = json.load(flux)
        self.assertEqual(ventes["champs"], prep.CHAMPS_VENTE)
        dates = [v[0] for v in ventes["ventes"]]
        self.assertEqual(dates, sorted(dates, reverse=True), "ventes non triees du recent au vieux")

        self.assertTrue(prep.verifier(sortie, tolerant=True))


class TestControlesExhaustifs(unittest.TestCase):
    """Une corruption par regle, et le message doit nommer le coupable.

    Ces sept corruptions passaient TOUTES l'ancien verifier() sans un mot :
    il ne regardait ni les fichiers de ventes, ni l'adjacence, ni les
    coordonnees, et seulement deux des quatorze fichiers de bandes.
    """

    @classmethod
    def setUpClass(cls):
        import io
        import contextlib
        cls.reference = tempfile.mkdtemp(prefix="controle-reference-")
        argv = sys.argv
        sys.argv = ["preparer_donnees.py", "--source-locale", FIXTURES,
                    "--sortie", cls.reference]
        try:
            with contextlib.redirect_stdout(io.StringIO()):
                prep.RAPPORT.clear()
                prep.main()
        finally:
            sys.argv = argv

    def controler_apres(self, abimer):
        """Copie les donnees de reference, les abime, et renvoie les problemes."""
        dossier = tempfile.mkdtemp(prefix="controle-")
        shutil.rmtree(dossier)
        shutil.copytree(self.reference, dossier)
        abimer(dossier)
        return prep.controler(dossier, tolerant=True)

    @staticmethod
    def _charger(dossier, *chemin):
        with open(os.path.join(dossier, *chemin), encoding="utf-8") as flux:
            return json.load(flux)

    @staticmethod
    def _ecrire(donnees, dossier, *chemin):
        with open(os.path.join(dossier, *chemin), "w", encoding="utf-8") as flux:
            json.dump(donnees, flux)

    def test_donnees_intactes_ne_signalent_rien(self):
        """Sans ce test, tous les autres pourraient passer pour de mauvaises raisons."""
        self.assertEqual(prep.controler(self.reference, tolerant=True), [])

    def test_fichier_de_ventes_manquant(self):
        def abimer(d):
            os.remove(os.path.join(d, "ventes", "30", "30189.json"))
        problemes = self.controler_apres(abimer)
        self.assertEqual(len(problemes), 1)
        self.assertIn("30189", problemes[0])
        self.assertIn("aucun fichier", problemes[0])

    def test_nombre_de_ventes_annonce_faux(self):
        def abimer(d):
            table = self._charger(d, "communes.json")
            i = table["champs"].index("n")
            for ligne in table["valeurs"]:
                if ligne[0] == "30189":
                    ligne[i] = 9999
            self._ecrire(table, d, "communes.json")
        problemes = self.controler_apres(abimer)
        self.assertTrue(any("30189" in p and "annoncees" in p for p in problemes),
                        "le fichier de ventes ne correspond plus au nombre annonce : %s" % problemes)

    def test_adjacence_non_symetrique(self):
        def abimer(d):
            voisins = self._charger(d, "adjacence.json")
            for code in list(voisins):
                if voisins[code]:
                    voisins[code] = voisins[code][1:]
                    break
            self._ecrire(voisins, d, "adjacence.json")
        problemes = self.controler_apres(abimer)
        self.assertEqual(len(problemes), 1)
        self.assertIn("symetrique", problemes[0])

    def test_fichier_de_ventes_orphelin(self):
        def abimer(d):
            self._ecrire({"code": "30999", "champs": prep.CHAMPS_VENTE, "ventes": []},
                         d, "ventes", "30", "30999.json")
        problemes = self.controler_apres(abimer)
        self.assertEqual(len(problemes), 1)
        self.assertIn("orphelin", problemes[0])

    def test_coordonnee_hors_de_France(self):
        def abimer(d):
            table = self._charger(d, "ventes", "30", "30189.json")
            table["ventes"][0][table["champs"].index("lat")] = 64.9   # Islande
            self._ecrire(table, d, "ventes", "30", "30189.json")
        problemes = self.controler_apres(abimer)
        self.assertEqual(len(problemes), 1)
        self.assertIn("hors de France", problemes[0])

    def test_total_annonce_faux(self):
        def abimer(d):
            meta = self._charger(d, "meta.json")
            meta["nb_ventes"] = 999
            self._ecrire(meta, d, "meta.json")
        problemes = self.controler_apres(abimer)
        self.assertTrue(any("total incoherent" in p for p in problemes), problemes)

    def test_ventes_mal_triees(self):
        """L'application affiche les ventes de la plus recente a la plus ancienne."""
        def abimer(d):
            table = self._charger(d, "ventes", "30", "30189.json")
            table["ventes"].reverse()
            self._ecrire(table, d, "ventes", "30", "30189.json")
        problemes = self.controler_apres(abimer)
        self.assertEqual(len(problemes), 1, "un seul signalement par fichier, pas un par paire")
        self.assertIn("non triees", problemes[0])

    def test_quartiles_incoherents(self):
        def abimer(d):
            table = self._charger(d, "communes.json")
            i = table["champs"].index("m2_q1")
            for ligne in table["valeurs"]:
                if ligne[0] == "30189":
                    ligne[i] = 99999
            self._ecrire(table, d, "communes.json")
        problemes = self.controler_apres(abimer)
        self.assertTrue(any("quartiles" in p for p in problemes), problemes)


if __name__ == "__main__":
    unittest.main()


class TestPertinenceDuPrixDuTerrain(unittest.TestCase):
    """Une pente trop faible n'est pas une mesure : c'est du bruit.

    L'ajustement terrain est plafonne a 2 500 m2. Sous 3 EUR/m2, il pese moins
    que la fourchette minimale que l'estimation s'impose deja : le publier
    donnerait l'illusion d'une precision inexistante.
    """

    @staticmethod
    def points(pente, n=4000):
        return [(float(100 + (i * 1900) // n), pente * (100 + (i * 1900) // n))
                for i in range(n)]

    def test_pente_negligeable_ecartee(self):
        # cas reel : Haute-Garonne, 0,85 EUR/m2 -> +2 100 EUR pour 2 500 m2
        self.assertIsNone(prep.pente_theil_sen(self.points(0.85), random.Random(1)))
        self.assertIsNone(prep.pente_theil_sen(self.points(2.9), random.Random(1)))

    def test_pente_utile_conservee(self):
        # cas reels : Drome 10,5 ; Pyrenees-Orientales 63,7
        for pente in (10.5, 63.7):
            self.assertIsNotNone(prep.pente_theil_sen(self.points(pente), random.Random(1)),
                                 "%s EUR/m2 est une mesure exploitable" % pente)

    def test_le_seuil_reste_coherent_avec_le_plafond_d_ajustement(self):
        """Garde-fou : le seuil doit rester lie a ce que l'ajustement peut peser."""
        effet_max = prep.PRIX_TERRAIN_MIN * prep.TERRAIN_PLAFOND_REGRESSION
        self.assertGreaterEqual(effet_max, 5000,
                                "sous ce seuil, l'ajustement est invisible dans la fourchette")


# --------------------------------------------------------------------------
# Telechargement (D3)
# --------------------------------------------------------------------------
# Un vrai serveur HTTP local, pas un faux urlopen : c'est le seul moyen de
# prouver que Content-Length est reellement verifie et qu'un corps tronque est
# rejete. Bibliotheque standard uniquement, port libre, aucun acces reseau.

class ServeurScripte(object):
    """Sert une liste de reponses preparees, une par requete, dans l'ordre."""

    def __init__(self, reponses):
        self.reponses = list(reponses)
        self.recues = []
        essai = self

        class Gestionnaire(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.0"

            def log_message(self, *_args):
                pass

            def _repondre(self):
                essai.recues.append(self.path)
                index = min(len(essai.recues) - 1, len(essai.reponses) - 1)
                code, corps, longueur_annoncee = essai.reponses[index]
                self.send_response(code)
                if longueur_annoncee is not None:
                    self.send_header("Content-Length", str(longueur_annoncee))
                self.end_headers()
                if corps:
                    self.wfile.write(corps)

            do_GET = _repondre
            do_HEAD = _repondre

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Gestionnaire)
        self.url = "http://127.0.0.1:%d/fichier.csv.gz" % self.httpd.server_address[1]

    def __enter__(self):
        self.fil = threading.Thread(target=self.httpd.serve_forever)
        self.fil.daemon = True
        self.fil.start()
        return self

    def __exit__(self, *_):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.fil.join(timeout=5)


class TestTelechargement(unittest.TestCase):
    """Le reseau echoue : on reessaie, sans jamais garder un fichier incomplet."""

    def setUp(self):
        self.dossier = tempfile.mkdtemp(prefix="dvf-test-")
        self.destination = os.path.join(self.dossier, "fichier.csv.gz")
        # Les vraies attentes (5 s puis 20 s) rendraient la suite interminable.
        self.attentes = prep.ATTENTES_REESSAI
        prep.ATTENTES_REESSAI = (0, 0)

    def tearDown(self):
        prep.ATTENTES_REESSAI = self.attentes
        shutil.rmtree(self.dossier, ignore_errors=True)

    def test_succes_du_premier_coup(self):
        corps = b"colonne\nvaleur\n"
        with ServeurScripte([(200, corps, len(corps))]) as serveur:
            self.assertTrue(prep.telecharger(serveur.url, self.destination))
            self.assertEqual(len(serveur.recues), 1)
        self.assertEqual(open(self.destination, "rb").read(), corps,
                         "le contenu doit etre identique a l'octet pres")

    def test_une_panne_passagere_est_reessayee(self):
        corps = b"colonne\nvaleur\n"
        with ServeurScripte([(500, b"", 0), (200, corps, len(corps))]) as serveur:
            self.assertTrue(prep.telecharger(serveur.url, self.destination))
            self.assertEqual(len(serveur.recues), 2,
                             "un 500 doit declencher exactement un reessai")
        self.assertEqual(open(self.destination, "rb").read(), corps)

    def test_un_404_n_est_pas_reessaye(self):
        with ServeurScripte([(404, b"", 0)]) as serveur:
            self.assertFalse(prep.telecharger(serveur.url, self.destination))
            self.assertEqual(len(serveur.recues), 1,
                             "le serveur a repondu : insister ne sert a rien")

    def test_abandon_apres_le_nombre_maximal_de_tentatives(self):
        with ServeurScripte([(503, b"", 0)]) as serveur:
            self.assertFalse(prep.telecharger(serveur.url, self.destination))
            self.assertEqual(len(serveur.recues), prep.TENTATIVES_MAX)

    def test_un_corps_tronque_est_rejete(self):
        """Le piege le plus sournois : une coupure en fin de transfert."""
        with ServeurScripte([(200, b"deb", 4096)]) as serveur:
            self.assertFalse(prep.telecharger(serveur.url, self.destination))
        self.assertFalse(os.path.exists(self.destination),
                         "un fichier tronque ne doit jamais porter le nom definitif")
        self.assertFalse(os.path.exists(self.destination + ".part"),
                         "le fichier de travail doit etre nettoye")

    def test_url_existe_distingue_l_absence_de_la_panne(self):
        with ServeurScripte([(200, b"", 0)]) as serveur:
            self.assertIs(prep.url_existe(serveur.url), True)
        with ServeurScripte([(404, b"", 0)]) as serveur:
            self.assertIs(prep.url_existe(serveur.url), False,
                          "404 = le millesime n'existe pas")
        with ServeurScripte([(503, b"", 0)]) as serveur:
            self.assertIsNone(prep.url_existe(serveur.url),
                              "panne = on ne sait pas, ce n'est pas une absence")


class TestMatriceDeTelechargement(unittest.TestCase):
    """La matrice (annee x departement) doit etre pleine, ou rien n'est publie."""

    ANNEES = [2021, 2022, 2023, 2024, 2025]

    def setUp(self):
        self.dossier = tempfile.mkdtemp(prefix="dvf-matrice-")
        # 70 lignes de journal par test noieraient la sortie ; ces tests portent
        # sur ce qui est renvoye et sur le message d'erreur, pas sur le journal.
        self.journal = prep.journal
        prep.journal = lambda _message: None

    def tearDown(self):
        prep.journal = self.journal
        shutil.rmtree(self.dossier, ignore_errors=True)

    def telechargeur(self, trous):
        """Fabrique un faux telechargeur qui echoue sur les couples donnes."""
        def faux(url, destination):
            for dep, annee in trous:
                if "/%s/" % annee in url and url.endswith("/%s.csv.gz" % dep):
                    return False
            open(destination, "wb").close()
            return True
        return faux

    def test_matrice_pleine(self):
        fichiers, millesimes = prep.telecharger_millesimes(
            self.ANNEES, self.dossier, self.telechargeur([]))
        self.assertEqual(millesimes, self.ANNEES)
        self.assertEqual(len(fichiers), len(self.ANNEES) * len(prep.DEPARTEMENTS))
        for chemin in fichiers:
            self.assertTrue(os.path.exists(chemin))

    def test_un_trou_partiel_arrete_tout(self):
        with self.assertRaises(SystemExit) as capture:
            prep.telecharger_millesimes(self.ANNEES, self.dossier,
                                        self.telechargeur([("30", 2024)]))
        message = str(capture.exception)
        self.assertIn("30 en 2024", message, "le couple fautif doit etre nomme")
        self.assertIn("rien ne sera publie", message)

    def test_une_annee_absente_partout_est_retiree(self):
        trous = [(dep, 2025) for dep in prep.DEPARTEMENTS]
        fichiers, millesimes = prep.telecharger_millesimes(
            self.ANNEES, self.dossier, self.telechargeur(trous))
        self.assertEqual(millesimes, [2021, 2022, 2023, 2024],
                         "l'Etat peut decaler une publication entiere")
        self.assertEqual(len(fichiers), 4 * len(prep.DEPARTEMENTS))

    def test_trop_peu_d_annees_restantes(self):
        trous = [(dep, annee) for dep in prep.DEPARTEMENTS for annee in (2024, 2025)]
        with self.assertRaises(SystemExit) as capture:
            prep.telecharger_millesimes([2023, 2024, 2025], self.dossier,
                                        self.telechargeur(trous))
        self.assertIn("il en faut au moins %d" % prep.MIN_MILLESIMES,
                      str(capture.exception))

    def test_les_millesimes_renvoyes_correspondent_aux_fichiers(self):
        """Le contrat que la regle I de controler() verifie sur les donnees publiees."""
        trous = [(dep, 2021) for dep in prep.DEPARTEMENTS]
        fichiers, millesimes = prep.telecharger_millesimes(
            self.ANNEES, self.dossier, self.telechargeur(trous))
        annees_des_fichiers = set(
            int(os.path.basename(c).split("-")[1].split(".")[0]) for c in fichiers)
        self.assertEqual(annees_des_fichiers, set(millesimes),
                         "meta.json ne doit jamais annoncer une annee absente des donnees")

    def test_le_tableau_de_couverture_montre_les_trous(self):
        obtenus = dict((annee, dict((dep, "x") for dep in prep.DEPARTEMENTS))
                       for annee in self.ANNEES)
        del obtenus[2024]["30"]
        lignes = prep.tableau_de_couverture(self.ANNEES, obtenus)
        ligne_gard = [l for l in lignes if l.startswith("  30 ")][0]
        self.assertEqual(ligne_gard.count("X"), 4)
        self.assertEqual(ligne_gard.count("-"), 1)


class TestSondageDesMillesimes(unittest.TestCase):
    """Combien de requetes coute la recherche des annees disponibles ?

    Ce test existe parce que la question a ete mal traitee une fois : en
    remplacant un all() sur generateur (qui s'arrete au premier echec) par un
    dictionnaire complet, l'annee en cours -- jamais encore publiee -- est
    passee de un sondage a quatorze, chacun reessayable trois fois. Le robot
    a mis treize minutes la ou il en mettait cinq.
    """

    def setUp(self):
        self.vrai_url_existe = prep.url_existe
        self.sondages = []

    def tearDown(self):
        prep.url_existe = self.vrai_url_existe

    def brancher(self, reponse):
        def faux(url):
            self.sondages.append(url)
            return reponse(url)
        prep.url_existe = faux

    @staticmethod
    def annee_de(url):
        return int(url.split("/csv/")[1].split("/")[0])

    def test_une_annee_absente_ne_coute_qu_un_sondage(self):
        derniere_publiee = dt.date.today().year - 1
        self.brancher(lambda url: self.annee_de(url) <= derniere_publiee)

        trouvees = prep.millesimes_disponibles(3)

        self.assertEqual(trouvees, [derniere_publiee - 2, derniere_publiee - 1,
                                    derniere_publiee])
        annee_en_cours = dt.date.today().year
        sondages_inutiles = [u for u in self.sondages
                             if self.annee_de(u) == annee_en_cours]
        self.assertEqual(len(sondages_inutiles), 1,
                         "une annee non publiee doit etre ecartee au premier refus")
        self.assertEqual(len(self.sondages), 1 + 3 * len(prep.DEPARTEMENTS),
                         "aucun sondage superflu sur les annees retenues")

    def test_un_etat_inconnu_arrete_tout(self):
        """Une panne reseau n'est pas une absence : on ne devine pas."""
        derniere_publiee = dt.date.today().year - 1

        def reponse(url):
            if self.annee_de(url) > derniere_publiee:
                return False
            return None if url.endswith("/07.csv.gz") else True

        self.brancher(reponse)
        with self.assertRaises(SystemExit) as capture:
            prep.millesimes_disponibles(3)
        self.assertIn("departement 07", str(capture.exception))
