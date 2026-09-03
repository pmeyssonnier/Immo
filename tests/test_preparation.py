# -*- coding: utf-8 -*-
"""Verifie que le nettoyage des donnees DVF fait bien ce qu'on attend.

Chaque test correspond a un piege reel du fichier DVF. Lancer avec :
    python -m unittest discover tests
"""

import csv
import json
import os
import sys
import tempfile
import unittest
from collections import defaultdict

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

        # les ventes d'une commune sont dans leur propre fichier
        chemin = os.path.join(sortie, "ventes", "30", "30189.json")
        self.assertTrue(os.path.exists(chemin))
        with open(chemin, encoding="utf-8") as flux:
            ventes = json.load(flux)
        self.assertEqual(ventes["champs"], prep.CHAMPS_VENTE)
        dates = [v[0] for v in ventes["ventes"]]
        self.assertEqual(dates, sorted(dates, reverse=True), "ventes non triees du recent au vieux")

        self.assertTrue(prep.verifier(sortie, tolerant=True))


if __name__ == "__main__":
    unittest.main()
