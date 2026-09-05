#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Sonde : MESURER avant de construire (DPE de l'ADEME + risques Georisques).

Ce programme est JETABLE et il ne construit rien. Il ne modifie pas le site, il
n'ecrit rien dans data/, il ne publie aucune donnee. Il ne fait qu'imprimer des
chiffres, pour repondre a des questions qu'on ne peut pas trancher en reflechissant :

  0. LE VERROU : ces sources sont-elles vraiment gratuites et sans compte ?
  1. Quel est leur format REEL ? (constate, jamais suppose)
  2. Combien de ventes DVF trouvent leur DPE, et par quelle cle ?
  3. Ce taux tient-il dans les communes RURALES, ou seulement en ville ?
  4. Combien ca coute en temps et en octets ?

Pourquoi ce detour : l'environnement de developpement n'a pas acces a
data.ademe.fr ni a georisques.gouv.fr. Ce script est donc fait pour tourner sur
les serveurs de GitHub, qui y ont acces -- exactement comme le robot de donnees.

IMPORTANT -- CE PROGRAMME NE PEUT RIEN ACHETER. Il ne porte aucune clef, aucun
jeton, aucun identifiant, aucun moyen de paiement. Si une source en reclame un,
il s'arrete et le dit.

Usage :
    python3 scripts/sonder_dpe_risques.py --dep 30 --annees 5
    python3 scripts/sonder_dpe_risques.py --verrou-seulement
"""

import argparse
import json
import os
import re
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter, defaultdict

# On reutilise le robot existant plutot que de reecrire le nettoyage DVF : c'est
# le MEME ensemble de ventes que le site affiche, sinon la mesure ne voudrait
# rien dire.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import preparer_donnees as prep  # noqa: E402

RACINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

DELAI = 60
ENTETES = {"User-Agent": "immo-gard-ardeche-sonde/1.0 (mesure de faisabilite)"}

# Codes qui signifient « il faut payer, s'identifier, ou demander la permission ».
# Ce sont eux qui referment le verrou.
CODES_BARRIERE = {401, 402, 403, 407}
# Et les mots qui trahissent la meme chose dans un corps de reponse.
MOTS_BARRIERE = re.compile(
    r"api[_ -]?key|cl[ée] d'?api|token requis|require[sd]? (?:a )?(?:token|key|subscription)"
    r"|abonnement|souscription|paiement requis|payment required",
    re.I,
)

# Combien de DPE au maximum on accepte de telecharger : garde-fou, pour qu'une
# sonde ne se transforme jamais en aspirateur.
PLAFOND_DPE = 400_000
PLAFOND_SECONDES = 900

_octets_telecharges = 0


# --------------------------------------------------------------------------
# Reseau : on ne leve JAMAIS d'exception, on rapporte
# --------------------------------------------------------------------------

def journal(message):
    print(message, flush=True)


def lire_url(url, delai=DELAI):
    """Va chercher une URL et rapporte ce qui s'est passe, sans jamais planter.

    Renvoie un dict : statut (int ou None), entetes, corps (bytes), erreur (str).
    Un echec n'est pas une exception ici : c'est un RESULTAT de mesure.
    """
    global _octets_telecharges
    requete = urllib.request.Request(url, headers=ENTETES)
    debut = time.time()
    try:
        with urllib.request.urlopen(requete, timeout=delai) as reponse:
            corps = reponse.read()
            _octets_telecharges += len(corps)
            return {"statut": reponse.status, "entetes": dict(reponse.headers),
                    "corps": corps, "erreur": None, "duree": time.time() - debut,
                    "url": url}
    except urllib.error.HTTPError as erreur:
        corps = b""
        try:
            corps = erreur.read()
        except Exception:
            pass
        return {"statut": erreur.code, "entetes": dict(erreur.headers or {}),
                "corps": corps, "erreur": "HTTP %s" % erreur.code,
                "duree": time.time() - debut, "url": url}
    except Exception as erreur:                       # reseau, DNS, TLS, delai
        return {"statut": None, "entetes": {}, "corps": b"",
                "erreur": "%s: %s" % (type(erreur).__name__, erreur),
                "duree": time.time() - debut, "url": url}


def lire_json(url, delai=DELAI):
    reponse = lire_url(url, delai)
    if reponse["statut"] == 200 and reponse["corps"]:
        try:
            reponse["json"] = json.loads(reponse["corps"].decode("utf-8"))
        except Exception as erreur:
            reponse["erreur"] = "reponse illisible : %s" % erreur
    return reponse


def barriere(reponse):
    """La source demande-t-elle un paiement, une clef ou un compte ?"""
    if reponse["statut"] in CODES_BARRIERE:
        return "HTTP %s" % reponse["statut"]
    if "WWW-Authenticate" in reponse["entetes"]:
        return "en-tete WWW-Authenticate : %s" % reponse["entetes"]["WWW-Authenticate"]
    extrait = reponse["corps"][:4000].decode("utf-8", "replace")
    trouve = MOTS_BARRIERE.search(extrait)
    if trouve and reponse["statut"] != 200:
        return "la reponse parle de « %s »" % trouve.group(0)
    return None


# --------------------------------------------------------------------------
# ETAPE A -- LE VERROU : gratuit, sans compte, sous quelle licence ?
# --------------------------------------------------------------------------

# On ne code pas en dur un identifiant de jeu de donnees qu'on n'a pas pu
# verifier : on demande a l'ADEME ce qu'elle publie, et on choisit ensuite.
ADEME_RECHERCHE = ("https://data.ademe.fr/data-fair/api/v1/datasets"
                   "?q=DPE%20logements%20existants&size=20"
                   "&select=id,title,count,license,updatedAt")
ADEME_DATASET = "https://data.ademe.fr/data-fair/api/v1/datasets/%s"

GEORISQUES_ESSAIS = [
    "https://georisques.gouv.fr/api/v1/gaspar/risques?code_insee=30189&page=1&page_size=5",
    "https://www.georisques.gouv.fr/api/v1/gaspar/risques?code_insee=30189&page=1&page_size=5",
]


def verrou_gratuite():
    """Premier geste : etablir que les deux sources sont libres d'acces.

    Renvoie (ouvert, rapport). Si ouvert est False, la sonde s'arrete : on ne
    mesure pas une source qu'on n'a pas le droit d'utiliser gratuitement.
    """
    journal("\n" + "=" * 74)
    journal("ETAPE A -- VERROU : ces sources sont-elles gratuites et sans compte ?")
    journal("=" * 74)

    rapport = {"ademe": {}, "georisques": {}, "obstacles": []}

    # --- ADEME ------------------------------------------------------------
    journal("\n[ADEME] recherche des jeux de donnees DPE, sans aucune authentification")
    reponse = lire_json(ADEME_RECHERCHE)
    obstacle = barriere(reponse)
    rapport["ademe"] = {"url": ADEME_RECHERCHE, "statut": reponse["statut"],
                        "erreur": reponse["erreur"], "obstacle": obstacle}
    if obstacle:
        journal("  BARRIERE : %s" % obstacle)
        rapport["obstacles"].append("ADEME : %s" % obstacle)
    elif reponse["statut"] != 200:
        journal("  injoignable : %s" % (reponse["erreur"] or reponse["statut"]))
        rapport["obstacles"].append("ADEME injoignable : %s"
                                    % (reponse["erreur"] or reponse["statut"]))
    else:
        jeux = (reponse.get("json") or {}).get("results", [])
        journal("  accessible sans clef. %d jeu(x) trouve(s) :" % len(jeux))
        for jeu in jeux[:10]:
            licence = (jeu.get("license") or {})
            journal("    - %-34s %10s lignes   licence : %s"
                    % (jeu.get("id", "?")[:34], jeu.get("count", "?"),
                       licence.get("title") or licence.get("href") or "non declaree"))
        rapport["ademe"]["jeux"] = jeux

    # --- Georisques -------------------------------------------------------
    journal("\n[Georisques] appel de l'API publique, sans aucune authentification")
    for url in GEORISQUES_ESSAIS:
        reponse = lire_json(url)
        obstacle = barriere(reponse)
        journal("  %s -> statut %s%s"
                % (urllib.parse.urlparse(url).netloc, reponse["statut"],
                   "  BARRIERE : " + obstacle if obstacle else ""))
        rapport["georisques"] = {"url": url, "statut": reponse["statut"],
                                 "erreur": reponse["erreur"], "obstacle": obstacle}
        if obstacle:
            rapport["obstacles"].append("Georisques : %s" % obstacle)
            break
        if reponse["statut"] == 200:
            rapport["georisques"]["exemple"] = reponse.get("json")
            break
    else:
        rapport["obstacles"].append("Georisques injoignable sur toutes les adresses essayees")

    if rapport["georisques"].get("statut") not in (200, None) \
            and not rapport["georisques"].get("obstacle"):
        rapport["obstacles"].append(
            "Georisques : statut %s" % rapport["georisques"]["statut"])

    ouvert = not rapport["obstacles"]
    journal("\n" + ("-> VERROU OUVERT : les deux sources repondent sans clef ni compte."
                    if ouvert else
                    "-> VERROU FERME. On s'arrete ici, comme prevu :"))
    for obstacle in rapport["obstacles"]:
        journal("     * %s" % obstacle)
    return ouvert, rapport


# --------------------------------------------------------------------------
# ETAPE B -- constater le format REEL
# --------------------------------------------------------------------------

def choisir_jeu_dpe(jeux):
    """Choisit le jeu « logements existants », le plus gros a defaut."""
    candidats = [j for j in jeux if "existant" in (j.get("id", "") + j.get("title", "")).lower()]
    if not candidats:
        candidats = list(jeux)
    if not candidats:
        return None
    return max(candidats, key=lambda j: j.get("count") or 0)


def schema_dpe(identifiant):
    """Imprime les colonnes REELLEMENT servies, et rend la liste des clefs."""
    journal("\n" + "=" * 74)
    journal("ETAPE B -- le format reel du jeu « %s »" % identifiant)
    journal("=" * 74)
    reponse = lire_json((ADEME_DATASET % urllib.parse.quote(identifiant)) + "/schema")
    if reponse["statut"] != 200:
        journal("  schema illisible : %s" % (reponse["erreur"] or reponse["statut"]))
        return []
    champs = [c.get("key") for c in (reponse.get("json") or []) if c.get("key")]
    journal("  %d colonnes. Celles qui nous interessent :" % len(champs))
    interessants = [c for c in champs if re.search(
        r"etiquette|type_batiment|date_|ban|parcelle|cadastr|geopoint|departement|insee|postal",
        c, re.I)]
    for champ in interessants:
        journal("    - %s" % champ)
    absents = [nom for nom in ("etiquette", "parcelle", "ban") if
               not any(nom in c.lower() for c in champs)]
    if absents:
        journal("  ATTENTION -- aucune colonne ne mentionne : %s" % ", ".join(absents))
    return champs


def trouver(champs, *motifs):
    """Premiere colonne dont le nom correspond a l'un des motifs, dans l'ordre."""
    for motif in motifs:
        for champ in champs:
            if re.fullmatch(motif, champ, re.I):
                return champ
    for motif in motifs:
        for champ in champs:
            if re.search(motif, champ, re.I):
                return champ
    return None


# --------------------------------------------------------------------------
# Normalisation des libelles de voie
# --------------------------------------------------------------------------

# La table d'abreviations n'est PAS recopiee ici : elle est lue dans
# js/adresses.js, ou elle a ete relevee sur les vraies adresses DVF. Deux copies
# divergeraient tot ou tard ; une seule source ne le peut pas.
def charger_abreviations():
    chemin = os.path.join(RACINE, "js", "adresses.js")
    with open(chemin, encoding="utf-8") as source:
        texte = source.read()
    bloc = re.search(r"const ABREGES_VOIE = \{(.*?)\n\};", texte, re.S)
    if not bloc:
        raise SystemExit("ERREUR : table ABREGES_VOIE introuvable dans js/adresses.js")
    table = dict(re.findall(r'(\w+):\s*"([^"]+)"', bloc.group(1)))
    if len(table) < 30:
        raise SystemExit("ERREUR : %d abreviations lues, c'est trop peu -- "
                         "le format de js/adresses.js a change." % len(table))
    return table


ABREGES = charger_abreviations()

ACCENTS = str.maketrans("àâäáãåçéèêëíìîïñóòôöõúùûüýÿœæ",
                        "aaaaaaceeeeiiiinooooouuuuyyea")


def normaliser_voie(texte):
    """« RTE DE COURBESSAC » et « Route de Courbessac » donnent la meme chose."""
    brut = (texte or "").lower().translate(ACCENTS)
    mots = [m for m in re.split(r"[^a-z0-9]+", brut) if m]
    developpes = []
    for mot in mots:
        developpes.extend(ABREGES.get(mot, mot).split(" "))
    return "".join(developpes)


def numero_normalise(numero, suffixe):
    numero = (numero or "").strip().lstrip("0") or None
    suffixe = (suffixe or "").strip().lower() or ""
    return (numero + suffixe) if numero else None


# --------------------------------------------------------------------------
# ETAPE C -- les ventes DVF, exactement celles que le site affiche
# --------------------------------------------------------------------------

def charger_ventes(dep, annees, dossier):
    """Rejoue le nettoyage du robot, en conservant en plus parcelle et adresse brute."""
    global _octets_telecharges
    journal("\n" + "=" * 74)
    journal("ETAPE C -- les ventes DVF du departement %s" % dep)
    journal("=" * 74)

    millesimes = prep.millesimes_disponibles(annees)
    ventes = []
    compteurs = Counter()
    for annee in millesimes:
        url = prep.URL_DVF.format(annee=annee, dep=dep)
        chemin = os.path.join(dossier, "dvf-%s-%s.csv.gz" % (dep, annee))
        journal("  %s ..." % url)
        try:
            prep.telecharger(url, chemin)
        except SystemExit as erreur:
            journal("    indisponible (%s) -- on continue sans ce millesime" % erreur)
            continue
        _octets_telecharges += os.path.getsize(chemin)

        ids = prep.passe1_ids_maisons(chemin)
        for lignes in prep.passe2_grouper(chemin, ids).values():
            vente = prep.consolider(lignes, compteurs)
            if vente is None:
                continue
            # consolider() jette la parcelle et les morceaux d'adresse. On les
            # reprend ici en refaisant EXACTEMENT son choix de ligne principale.
            maisons = [l for l in lignes if l.get("type_local") == "Maison"]
            principale = max(maisons,
                             key=lambda l: prep.nombre(l.get("surface_reelle_bati")) or 0.0)
            vente["parcelle"] = principale.get("id_parcelle") or None
            vente["voie"] = normaliser_voie(principale.get("adresse_nom_voie"))
            vente["numero"] = numero_normalise(principale.get("adresse_numero"),
                                               principale.get("adresse_suffixe"))
            vente["date"] = (lignes[0].get("date_mutation") or "")[:10]
            ventes.append(vente)

    journal("  %d ventes de maisons retenues sur %s" % (len(ventes), dep))
    sans_numero = sum(1 for v in ventes if not v["numero"])
    journal("  dont %d (%.1f %%) SANS numero de voirie -- lieux-dits"
            % (sans_numero, 100.0 * sans_numero / max(1, len(ventes))))
    return ventes


# --------------------------------------------------------------------------
# ETAPE C bis -- les DPE du meme departement
# --------------------------------------------------------------------------

def telecharger_dpe(identifiant, champs, dep):
    """Rapatrie les DPE de maisons du departement, en ne demandant que l'utile."""
    journal("\n" + "=" * 74)
    journal("ETAPE C bis -- les DPE de maisons du departement %s" % dep)
    journal("=" * 74)

    col = {
        "etiquette": trouver(champs, r"etiquette_dpe", r".*etiquette.*dpe.*"),
        "type": trouver(champs, r"type_batiment", r".*type.*b[aâ]timent.*"),
        "date": trouver(champs, r"date_etablissement_dpe", r"date_reception_dpe", r"date_.*dpe"),
        "voie": trouver(champs, r"adresse_ban", r"adresse_brut", r".*adresse.*"),
        "insee": trouver(champs, r"code_insee_ban", r"code_insee.*", r".*insee.*"),
        "dep": trouver(champs, r".*departement.*"),
        "parcelle": trouver(champs, r".*parcelle.*", r".*cadastr.*"),
        "point": trouver(champs, r"_geopoint", r".*geopoint.*"),
    }
    for role, nom in col.items():
        journal("  %-10s -> %s" % (role, nom or "AUCUNE COLONNE TROUVEE"))
    if not col["etiquette"] or not col["date"]:
        journal("  Sans etiquette ni date, la mesure n'a pas de sens. On s'arrete.")
        return [], col

    demandes = [c for c in col.values() if c]
    base = ADEME_DATASET % urllib.parse.quote(identifiant)
    if col["dep"]:
        filtre = '%s:"%s"' % (col["dep"], dep)
    elif col["insee"]:
        filtre = "%s:%s*" % (col["insee"], dep)
    else:
        journal("  Aucun moyen de filtrer par departement : on s'arrete plutot que "
                "de telecharger la France entiere.")
        return [], col
    journal("  filtre : %s" % filtre)

    url = base + "/lines?" + urllib.parse.urlencode({
        "size": 10000, "select": ",".join(sorted(set(demandes))), "qs": filtre,
    })
    lignes = []
    debut = time.time()
    pages = 0
    while url and len(lignes) < PLAFOND_DPE and time.time() - debut < PLAFOND_SECONDES:
        reponse = lire_json(url)
        if reponse["statut"] != 200:
            journal("  arret : %s" % (reponse["erreur"] or reponse["statut"]))
            break
        charge = reponse.get("json") or {}
        lignes.extend(charge.get("results", []))
        pages += 1
        url = charge.get("next")
        if pages % 5 == 0:
            journal("    %d DPE ... (%.0f s)" % (len(lignes), time.time() - debut))
    journal("  %d DPE recuperes en %.0f s, %d page(s)"
            % (len(lignes), time.time() - debut, pages))

    if lignes:
        journal("  exemple brut : %s"
                % json.dumps(lignes[0], ensure_ascii=False)[:300])
    return lignes, col


# --------------------------------------------------------------------------
# ETAPE D -- les cles d'appariement
# --------------------------------------------------------------------------

def decouper_adresse_ban(adresse):
    """« 12 B Rue Ampere 30000 Nimes » -> (numero, voie normalisee)."""
    texte = (adresse or "").strip()
    debut = re.match(r"^(\d+)\s*([A-Za-z]?)\s+(.*)$", texte)
    if not debut:
        return None, normaliser_voie(re.sub(r"\b\d{5}\b.*$", "", texte))
    reste = re.sub(r"\b\d{5}\b.*$", "", debut.group(3))
    return numero_normalise(debut.group(1), debut.group(2)), normaliser_voie(reste)


def indexer_dpe(lignes, col):
    """Range les DPE par cle, en ne gardant que les maisons."""
    par_parcelle = defaultdict(list)
    par_adresse = defaultdict(list)
    par_voie = defaultdict(list)
    gardes = 0
    for ligne in lignes:
        if col["type"] and "maison" not in str(ligne.get(col["type"], "")).lower():
            continue
        lettre = str(ligne.get(col["etiquette"]) or "").strip().upper()[:1]
        if lettre not in "ABCDEFG":
            continue
        date = str(ligne.get(col["date"]) or "")[:10]
        insee = str(ligne.get(col["insee"]) or "") if col["insee"] else ""
        numero, voie = decouper_adresse_ban(ligne.get(col["voie"]) if col["voie"] else "")
        entree = {"lettre": lettre, "date": date, "insee": insee}
        gardes += 1
        if col["parcelle"] and ligne.get(col["parcelle"]):
            par_parcelle[str(ligne[col["parcelle"]]).strip()].append(entree)
        if voie:
            par_voie[(insee, voie)].append(entree)
            if numero:
                par_adresse[(insee, voie, numero)].append(entree)
    journal("  %d DPE de maisons exploitables (%d parcelles, %d adresses, %d voies)"
            % (gardes, len(par_parcelle), len(par_adresse), len(par_voie)))
    return par_parcelle, par_adresse, par_voie


def choisir(candidats, date_vente, anterieur):
    """Le DPE le plus proche ; anterieur a la vente si on l'exige."""
    if not candidats:
        return None
    if anterieur:
        avant = [c for c in candidats if c["date"] and c["date"] <= date_vente]
        if not avant:
            return None
        return max(avant, key=lambda c: c["date"])
    return max(candidats, key=lambda c: c["date"] or "")


def apparier(ventes, index, anterieur):
    par_parcelle, par_adresse, par_voie = index
    resultats = {}
    for cle in ("K0", "K1", "K2", "K3", "K4"):
        resultats[cle] = []
    for vente in ventes:
        date = vente["date"]
        insee = vente["code_commune"]
        k0 = choisir(par_parcelle.get(vente["parcelle"] or "", []), date, anterieur)
        k1 = choisir(par_adresse.get((insee, vente["voie"], vente["numero"]), []),
                     date, anterieur) if vente["numero"] and vente["voie"] else None
        k2 = choisir(par_voie.get((insee, vente["voie"]), []), date, anterieur) \
            if vente["voie"] else None
        resultats["K0"].append(k0)
        resultats["K1"].append(k1)
        resultats["K2"].append(k2)
        resultats["K3"].append(None)          # mesuree a part, ci-dessous
        resultats["K4"].append(k1 or k2)
    return resultats


def taux(valeurs):
    trouves = sum(1 for v in valeurs if v)
    return trouves, 100.0 * trouves / max(1, len(valeurs))


def rapport_appariement(ventes, index, communes_rurales):
    journal("\n" + "=" * 74)
    journal("ETAPE D -- taux d'appariement par cle")
    journal("=" * 74)

    for anterieur in (False, True):
        titre = ("DPE ANTERIEUR a la vente (regle retenue)" if anterieur
                 else "n'importe quel DPE de l'adresse (moins rigoureux)")
        journal("\n  %s" % titre)
        resultats = apparier(ventes, index, anterieur)
        for cle in ("K0", "K1", "K2", "K4"):
            trouves, pourcent = taux(resultats[cle])
            journal("    %-3s %6d / %d  = %5.1f %%" % (cle, trouves, len(ventes), pourcent))

        if anterieur:
            meilleur = max(("K0", "K1", "K2", "K4"),
                           key=lambda c: taux(resultats[c])[0])
            journal("\n  Ventilation de la meilleure cle (%s) :" % meilleur)
            _ventiler(ventes, resultats[meilleur], communes_rurales)


def _ventiler(ventes, trouves, communes_rurales):
    par_annee = defaultdict(lambda: [0, 0])
    par_type = defaultdict(lambda: [0, 0])
    lettres = Counter()
    for vente, dpe in zip(ventes, trouves):
        annee = vente["date"][:4]
        par_annee[annee][1] += 1
        genre = "rurale" if vente["code_commune"] in communes_rurales else "urbaine"
        par_type[genre][1] += 1
        if dpe:
            par_annee[annee][0] += 1
            par_type[genre][0] += 1
            lettres[dpe["lettre"]] += 1

    journal("    par annee de vente :")
    for annee in sorted(par_annee):
        trouve, total = par_annee[annee]
        journal("      %s : %5d / %5d = %5.1f %%"
                % (annee, trouve, total, 100.0 * trouve / max(1, total)))
    journal("    par type de commune :")
    for genre in sorted(par_type):
        trouve, total = par_type[genre]
        journal("      %-8s : %5d / %5d = %5.1f %%"
                % (genre, trouve, total, 100.0 * trouve / max(1, total)))
    journal("    repartition des etiquettes trouvees :")
    total_lettres = sum(lettres.values()) or 1
    for lettre in "ABCDEFG":
        journal("      %s : %5d (%4.1f %%)"
                % (lettre, lettres[lettre], 100.0 * lettres[lettre] / total_lettres))
    passoires = lettres["F"] + lettres["G"]
    journal("      -> passoires thermiques (F+G) : %.1f %%"
            % (100.0 * passoires / total_lettres))


# --------------------------------------------------------------------------
# ETAPE E -- Georisques
# --------------------------------------------------------------------------

def sonder_georisques(exemple, codes):
    journal("\n" + "=" * 74)
    journal("ETAPE E -- Georisques")
    journal("=" * 74)
    if exemple:
        journal("  structure de la reponse pour Nimes :")
        journal("    %s" % json.dumps(exemple, ensure_ascii=False)[:900])

    echantillon = codes[:12]
    journal("\n  chronometrage sur %d communes :" % len(echantillon))
    debut = time.time()
    reussites = 0
    risques = Counter()
    for code in echantillon:
        reponse = lire_json("https://georisques.gouv.fr/api/v1/gaspar/risques"
                            "?code_insee=%s&page=1&page_size=50" % code)
        if reponse["statut"] == 200:
            reussites += 1
            for entree in (reponse.get("json") or {}).get("data", []) or []:
                libelle = entree.get("libelle_risque_long") or entree.get("num_risque")
                if libelle:
                    risques[str(libelle)] += 1
    duree = time.time() - debut
    par_appel = duree / max(1, len(echantillon))
    journal("  %d/%d reussis en %.1f s, soit %.2f s par commune"
            % (reussites, len(echantillon), duree, par_appel))
    journal("  -> extrapolation aux 3 900 communes du site : %.0f MINUTES"
            % (par_appel * 3900 / 60))
    if par_appel * 3900 / 60 > 20:
        journal("  -> trop lent pour un robot : il faudra un export telechargeable,")
        journal("     ou un robot separe a cadence trimestrielle (c'est le plan).")
    if risques:
        journal("  risques rencontres :")
        for libelle, nombre in risques.most_common(12):
            journal("    %-58s %d commune(s)" % (libelle[:58], nombre))


# --------------------------------------------------------------------------
# Assemblage
# --------------------------------------------------------------------------

def communes_rurales_du_dep(ventes, seuil=100):
    """« Rurale » = peu de ventes sur la periode. Grossier, mais suffisant ici."""
    compte = Counter(v["code_commune"] for v in ventes)
    return {code for code, n in compte.items() if n < seuil}


def main():
    analyseur = argparse.ArgumentParser(description=__doc__)
    analyseur.add_argument("--dep", default="30", help="departement sonde (defaut : 30)")
    analyseur.add_argument("--annees", type=int, default=5)
    analyseur.add_argument("--verrou-seulement", action="store_true",
                           help="ne faire que l'etape A")
    options = analyseur.parse_args()

    depart = time.time()
    journal("SONDE DPE + GEORISQUES -- mesure de faisabilite, aucune ecriture dans data/")
    journal("Ce programme ne porte aucune clef et ne peut rien acheter.")

    ouvert, rapport = verrou_gratuite()
    if not ouvert:
        journal("\nEtape 2 (construction) annulee : le verrou de gratuite n'est pas leve.")
        return 2
    if options.verrou_seulement:
        return 0

    jeu = choisir_jeu_dpe(rapport["ademe"].get("jeux") or [])
    if not jeu:
        journal("\nAucun jeu DPE exploitable trouve. On s'arrete.")
        return 3
    journal("\nJeu retenu : %s (%s lignes)" % (jeu.get("id"), jeu.get("count")))

    champs = schema_dpe(jeu["id"])
    if not champs:
        return 3

    with tempfile.TemporaryDirectory(prefix="sonde-") as dossier:
        ventes = charger_ventes(options.dep, options.annees, dossier)
        if not ventes:
            journal("Aucune vente : mesure impossible.")
            return 3

        lignes, col = telecharger_dpe(jeu["id"], champs, options.dep)
        if lignes:
            index = indexer_dpe(lignes, col)
            rapport_appariement(ventes, index, communes_rurales_du_dep(ventes))

        codes = sorted({v["code_commune"] for v in ventes})
        sonder_georisques(rapport["georisques"].get("exemple"), codes)

    journal("\n" + "=" * 74)
    journal("COUT DE LA SONDE")
    journal("=" * 74)
    journal("  %.1f Mo telecharges, %.1f minutes, pour UN departement."
            % (_octets_telecharges / 1e6, (time.time() - depart) / 60))
    journal("  Extrapolation brute aux 14 departements : %.0f Mo, %.0f minutes."
            % (_octets_telecharges / 1e6 * 14, (time.time() - depart) / 60 * 14))
    journal("  (Le robot dispose de 60 minutes ; il en utilise deja 10 pour les ventes.)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
