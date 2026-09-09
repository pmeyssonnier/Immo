#!/usr/bin/env python3
"""Sonde de faisabilite : une carte des prix immobiliers pour la BELGIQUE.

CE QUE CE SCRIPT FAIT, ET CE QU'IL NE FAIT PAS.
Il MESURE. Il n'ecrit rien dans data/, ne construit aucune sortie, ne modifie
aucun fichier du site. Il imprime des nombres, et c'est tout.

POURQUOI IL EXISTE.
L'environnement de developpement n'a pas acces a statbel.fgov.be ni a geo.be --
les deux sont bloques par le proxy sortant. Les serveurs de GitHub, eux, y
accedent. La question posee est trop consequente pour etre tranchee sur des
resumes de moteur de recherche : avant d'ecrire une ligne d'application, on veut
avoir OUVERT les fichiers.

CE QU'ON CHERCHE A ETABLIR, dans l'ordre ou ca compte :

  1. GRATUITE. Chaque source repond-elle sans compte, sans clef, sans paiement ?
     C'est le premier geste, et un echec ici arrete tout : on ne batit pas sur
     une source payante.

  2. GRANULARITE. La recherche prealable indique que TOUT est agrege cote belge :
     pas d'equivalent de DVF, pas de vente individuelle avec adresse. Il faut le
     verifier en ouvrant les fichiers, et regarder s'il existe une colonne
     d'adresse ou de parcelle quelque part. « Je n'ai pas trouve » n'est pas
     « ca n'existe pas ».

  3. LE RACCORD. Les codes des contours de communes correspondent-ils a ceux des
     statistiques ? C'est le point qui peut tout arreter, et c'est exactement ce
     qui a fait echouer le robot francais deux fois sur les arrondissements de
     Marseille -- OpenDataSoft renvoyait le code sous forme de LISTE. Un raccord
     a 60 % rendrait la carte inutilisable.

  4. LA COUVERTURE. Statbel annonce un seuil de 16 transactions par commune pour
     des raisons de confidentialite. Combien des 581 communes belges seraient
     donc coloriees, et combien resteraient grises ?

AUCUNE SOURCE N'EST TENUE POUR ACQUISE. Les URL ci-dessous sont des CANDIDATES :
la sonde les essaie et rapporte lesquelles repondent. Elle ne promet rien.

Usage :
    python3 scripts/sonder_belgique.py [--verrou-seulement] [--sans-contours]
"""

import argparse
import csv
import io
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import preparer_donnees as prep  # noqa: E402

DELAI = 90
ENTETES = {"User-Agent": "immo-sonde-belgique/1.0 (mesure de faisabilite)"}

# Codes qui signifient « il faut payer, s'identifier, ou demander la permission ».
CODES_BARRIERE = {401, 402, 403, 407}
MOTS_BARRIERE = re.compile(
    r"api[_ -]?key|cl[ée] d'?api|token requis|require[sd]? (?:a )?(?:token|key|subscription)"
    r"|abonnement|souscription|paiement requis|payment required|log ?in required",
    re.I,
)

# Garde-fou : une sonde ne doit jamais devenir un aspirateur.
PLAFOND_OCTETS = 300 * 1024 * 1024
PLAFOND_SECONDES = 1200

# La Belgique compte 581 communes depuis les fusions du 1er janvier 2019.
COMMUNES_BELGES = 581

_octets = 0
_depart = time.time()


# --------------------------------------------------------------------------
# Reseau : on ne leve JAMAIS d'exception, on rapporte
# --------------------------------------------------------------------------

def journal(message=""):
    print(message, flush=True)


def budget_epuise():
    if _octets > PLAFOND_OCTETS:
        return "plafond de telechargement atteint (%.0f Mo)" % (_octets / 1048576)
    if time.time() - _depart > PLAFOND_SECONDES:
        return "plafond de duree atteint (%d s)" % PLAFOND_SECONDES
    return None


def lire_url(url, delai=DELAI):
    """Va chercher une URL et rapporte ce qui s'est passe, sans jamais planter.

    Un echec n'est pas une exception ici : c'est un RESULTAT de mesure.
    """
    global _octets
    requete = urllib.request.Request(url, headers=ENTETES)
    debut = time.time()
    try:
        with urllib.request.urlopen(requete, timeout=delai) as reponse:
            corps = reponse.read()
            _octets += len(corps)
            return {"statut": reponse.status, "entetes": dict(reponse.headers),
                    "corps": corps, "erreur": None,
                    "duree": time.time() - debut, "url": url}
    except urllib.error.HTTPError as erreur:
        corps = b""
        try:
            corps = erreur.read()
        except Exception:
            pass
        return {"statut": erreur.code, "entetes": dict(erreur.headers or {}),
                "corps": corps, "erreur": "HTTP %s" % erreur.code,
                "duree": time.time() - debut, "url": url}
    except Exception as erreur:                        # reseau, DNS, TLS, delai
        return {"statut": None, "entetes": {}, "corps": b"",
                "erreur": "%s: %s" % (type(erreur).__name__, erreur),
                "duree": time.time() - debut, "url": url}


def sonder_entetes(url, delai=45):
    """Interroge une URL en HEAD : accessible ? quel poids ? SANS telecharger.

    Correction d'un defaut de la premiere version : le verrou faisait un GET
    complet, si bien qu'Eurostat consommait 120 Mo du budget avant meme qu'on
    ait ouvert un seul fichier de ventes. Un verrou doit couter presque rien.
    """
    global _octets
    requete = urllib.request.Request(url, headers=ENTETES, method="HEAD")
    debut = time.time()
    try:
        with urllib.request.urlopen(requete, timeout=delai) as reponse:
            entetes = dict(reponse.headers)
            return {"statut": reponse.status, "entetes": entetes, "corps": b"",
                    "erreur": None, "duree": time.time() - debut, "url": url,
                    "poids": int(entetes.get("Content-Length") or 0) or None}
    except urllib.error.HTTPError as erreur:
        # Certains serveurs refusent HEAD : on retombe sur un GET, mais seulement
        # pour ceux-la, et le cout reste rapporte.
        if erreur.code in (405, 501):
            reponse = lire_url(url, delai)
            reponse["poids"] = len(reponse["corps"]) or None
            return reponse
        return {"statut": erreur.code, "entetes": dict(erreur.headers or {}),
                "corps": b"", "erreur": "HTTP %s" % erreur.code,
                "duree": time.time() - debut, "url": url, "poids": None}
    except Exception as erreur:
        return {"statut": None, "entetes": {}, "corps": b"",
                "erreur": "%s: %s" % (type(erreur).__name__, erreur),
                "duree": time.time() - debut, "url": url, "poids": None}


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


def taille(octets):
    if octets is None:
        return "—"
    if octets < 1024:
        return "%d o" % octets
    if octets < 1048576:
        return "%.1f Ko" % (octets / 1024)
    return "%.2f Mo" % (octets / 1048576)


# --------------------------------------------------------------------------
# Les sources CANDIDATES. Rien ici n'est tenu pour acquis.
# --------------------------------------------------------------------------

# LES SOURCES. Deux familles, et la distinction compte.
#
# PAGES : des pages officielles dont on EXTRAIT les liens de telechargement.
# C'est la bonne facon de proceder : les noms de fichiers de Statbel portent une
# date (« ..._20230101.geojson.zip ») et changent a chaque millesime. Deviner une
# URL, c'est se condamner a un 404 dans six mois.
#
# DIRECTS : quelques URL documentees, essayees telles quelles.
#
# Aucune n'est tenue pour acquise. Une premiere version de ce fichier citait deux
# depots GitHub de contours belges que j'avais INVENTES ; testes depuis cet
# environnement -- qui atteint bien GitHub --, tous deux repondaient 404. Ils ont
# ete retires plutot que remplaces par d'autres suppositions.

# Les pages a explorer. L'ordre compte : la premiere sonde a brule tout son
# budget sur la geometrie et n'a jamais ouvert un fichier de ventes. Les
# statistiques passent donc devant.
PAGES = [
    ("Statbel — ventes par COMMUNE (fiche)",
     "https://statbel.fgov.be/fr/open-data/ventes-de-biens-immobiliers-selon-la-nature-du-bien-dans-lacte-de-vente"),
    ("Statbel — ventes par secteur statistique (fiche)",
     "https://statbel.fgov.be/en/open-data/real-estate-sales-according-nature-property-deed-sale-statistical-sectors-nis7-and-nis9"),
    ("Statbel — catalogue open data",
     "https://statbel.fgov.be/fr/open-data"),
    ("Statbel — catalogue open data (nl)",
     "https://statbel.fgov.be/nl/open-data"),
    ("SPF Finances — portail de telechargement du patrimoine",
     "https://finances.belgium.be/fr/experts-partenaires/donnees-ouvertes-patrimoine/jeux-donnees/portail-telechargement"),
]

# Explores en second temps seulement, et un seul format : la premiere sonde a
# telecharge le MEME jeu de secteurs en sqlite, shp et geojson, dans deux
# projections -- quatre fois le meme contenu pour rien.
PAGES_GEOMETRIE = [
    ("Statbel — catalogue open data (geometrie)",
     "https://statbel.fgov.be/fr/open-data"),
]

DIRECTS = []

# Ce qui, dans un lien, ressemble a un jeu de donnees utile.
LIEN_UTILE = re.compile(r"\.(zip|csv|xlsx|geojson|json|txt)(\?|$)", re.I)
# Ce qui parle de VENTES, et ce qui parle de GEOMETRIE. Les melanger, c'est
# retelecharger 150 Mo de contours avant d'avoir ouvert un seul prix.
LIEN_VENTES = re.compile(r"immo|onroerend|vastgoed|verkoop|vente|transacti", re.I)
LIEN_GEOMETRIE = re.compile(r"sector|secteur|munty|commune|gemeente", re.I)
# Un seul format par jeu : le geojson se lit sans outil, sqlite et shp non.
FORMAT_INUTILE = re.compile(r"\.(sqlite|shp|dbf|prj)\.zip$|\.sqlite$|\.shp$", re.I)


def extraire_liens(base, corps, sujet):
    """Tous les liens de telechargement plausibles d'une page.

    On lit le HTML avec une expression reguliere plutot qu'un analyseur : on ne
    cherche pas a comprendre la page, seulement a relever des href.
    """
    texte = corps.decode("utf-8", "replace")
    trouves = []
    for brut in re.findall(r'href="([^"]+)"', texte):
        lien = brut.replace("&amp;", "&")
        if not LIEN_UTILE.search(lien):
            continue
        if lien.startswith("/"):
            racine = re.match(r"https?://[^/]+", base)
            lien = (racine.group(0) if racine else "") + lien
        if not lien.startswith("http"):
            continue
        if FORMAT_INUTILE.search(lien):
            continue
        if sujet.search(lien):
            trouves.append(lien)
    # On garde l'ordre d'apparition, sans doublon.
    vus, sortie = set(), []
    for lien in trouves:
        if lien not in vus:
            vus.add(lien)
            sortie.append(lien)
    return sortie


# Mots qui, dans un nom de colonne, trahiraient une VENTE INDIVIDUELLE. C'est la
# question ouverte de cette sonde : rien de tel n'a ete trouve, mais « pas
# trouve » n'est pas « n'existe pas ».
COLONNES_INDIVIDUELLES = re.compile(
    r"adres|adresse|street|straat|rue|parcel|percee|kadaster|cadastr|"
    r"huisnummer|numero|house_?number|x_?coord|y_?coord|lat|lon", re.I)

# Mots qui trahissent au contraire un AGREGAT.
COLONNES_AGREGEES = re.compile(
    r"median|mediaan|mediane|moyen|gemiddeld|average|q1|q3|quartile|"
    r"aantal|nombre|number|count|total", re.I)


# --------------------------------------------------------------------------
# 1. Le verrou de gratuite
# --------------------------------------------------------------------------

def verrou_gratuite(sources):
    """Chaque source repond-elle SANS compte, clef ni paiement ?

    Par HEAD : on veut savoir si la porte s'ouvre, pas rapporter le meuble.
    """
    journal("=" * 74)
    journal("VERROU — les sources sont-elles accessibles sans compte ni paiement ?")
    journal("=" * 74)
    ouvertes = []
    for nom, url in sources:
        reponse = sonder_entetes(url)
        obstacle = barriere(reponse)
        if obstacle:
            journal("  FERME   %-46s %s" % (nom[:46], obstacle))
        elif reponse["statut"] == 200:
            journal("  ouverte %-46s %s" % (nom[:46], taille(reponse.get("poids"))))
            ouvertes.append((nom, url, reponse))
        else:
            journal("  muette  %-46s %s" % (nom[:46], reponse["erreur"] or "sans reponse"))
    journal()
    journal("  %d source(s) ouverte(s) sur %d  —  aucun octet de donnee telecharge"
            % (len(ouvertes), len(sources)))
    return ouvertes


# --------------------------------------------------------------------------
# 2. Que contiennent vraiment les fichiers ?
# --------------------------------------------------------------------------

def lire_tableau(corps, nom):
    """Extrait (colonnes, lignes) d'un CSV, eventuellement dans un ZIP.

    Renvoie None si le contenu n'est pas un tableau lisible -- ce qui est un
    resultat, pas une panne.
    """
    membres = []
    if corps[:2] == b"PK":
        try:
            archive = zipfile.ZipFile(io.BytesIO(corps))
            for info in archive.infolist():
                if info.filename.lower().endswith((".csv", ".txt", ".tsv")):
                    membres.append((info.filename, archive.read(info)))
        except Exception as erreur:
            journal("      zip illisible : %s" % erreur)
            return None
    else:
        membres.append((nom, corps))
    if not membres:
        return None

    resultats = []
    for nom_membre, brut in membres:
        texte = brut.decode("utf-8-sig", "replace")
        # Statbel melange les separateurs selon les jeux : on laisse le sniffer
        # decider plutot que de parier.
        echantillon = texte[:8192]
        try:
            dialecte = csv.Sniffer().sniff(echantillon, delimiters=",;\t|")
            separateur = dialecte.delimiter
        except Exception:
            separateur = ";" if echantillon.count(";") > echantillon.count(",") else ","
        lecteur = csv.reader(io.StringIO(texte), delimiter=separateur)
        try:
            colonnes = next(lecteur)
        except StopIteration:
            continue
        # On garde un echantillon en memoire mais on compte TOUT : le rapport
        # precedent affichait « 400 002 lignes », qui etait mon propre plafond
        # et non le contenu du fichier.
        lignes, total = [], 0
        for ligne in lecteur:
            total += 1
            if len(lignes) < 600000:
                lignes.append(ligne)
        resultats.append({"membre": nom_membre, "separateur": separateur,
                          "colonnes": colonnes, "lignes": lignes,
                          "total": total, "octets": len(brut)})
    return resultats


def decrire_tableau(tableau):
    """Imprime ce qu'on a VRAIMENT sous les yeux : colonnes, volumes, annees."""
    colonnes = tableau["colonnes"]
    lignes = tableau["lignes"]
    journal("      membre        : %s  (%s, separateur « %s »)"
            % (tableau["membre"], taille(tableau["octets"]), tableau["separateur"]))
    journal("      lignes        : %s%s"
            % (format(tableau.get("total", len(lignes)), ",d").replace(",", " "),
               "" if tableau.get("total", 0) <= len(lignes)
               else " (echantillon de %s en memoire)"
                    % format(len(lignes), ",d").replace(",", " ")))
    journal("      colonnes (%d)  : %s" % (len(colonnes), ", ".join(colonnes[:14])))
    if len(colonnes) > 14:
        journal("                      … et %d autres" % (len(colonnes) - 14))

    individuelles = [c for c in colonnes if COLONNES_INDIVIDUELLES.search(c)]
    agregees = [c for c in colonnes if COLONNES_AGREGEES.search(c)]
    journal("      -> colonnes d'AGREGAT    : %s" % (", ".join(agregees) or "aucune"))
    journal("      -> colonnes INDIVIDUELLES: %s" % (", ".join(individuelles) or "aucune"))
    if individuelles:
        journal("         ATTENTION : une colonne d'adresse ou de coordonnees existe.")
        journal("         C'est la question ouverte de cette sonde -- a examiner de pres.")

    # Annees presentes, si une colonne y ressemble.
    for i, nom in enumerate(colonnes):
        if re.search(r"^(ms_)?(year|jaar|annee|periode|refnis_period|cd_year)", nom, re.I):
            valeurs = sorted({l[i] for l in lignes[:200000] if i < len(l) and l[i]})
            if valeurs:
                journal("      annees (%s)   : %s" % (nom, ", ".join(valeurs[:12])))
            break

    if lignes:
        journal("      1re ligne     : %s" % " | ".join(lignes[0][:10]))
    return colonnes, lignes


def codes_de_commune(colonnes, lignes):
    """Extrait l'ensemble des codes de commune presents dans un tableau.

    Statbel ne publie pas de colonne « commune » dans le fichier des ventes par
    secteur : le code de commune est les CINQ PREMIERS caracteres du code de
    secteur (« 11001A00- » -> commune 11001). La premiere version cherchait une
    colonne REFNIS, n'en trouvait pas, et le raccord restait donc impossible a
    mesurer alors que l'information etait la.
    """
    for i, nom in enumerate(colonnes):
        if re.search(r"stat_?sector|cd_sector", nom, re.I):
            codes = {l[i].strip()[:5] for l in lignes if i < len(l) and l[i].strip()}
            codes = {c for c in codes if re.fullmatch(r"\d{5}", c)}
            if codes:
                return nom + " (5 premiers caracteres)", codes
    for i, nom in enumerate(colonnes):
        if re.search(r"refnis|nis[_ ]?code|cd_munty|cd_refnis|^nis$|munty", nom, re.I):
            codes = {l[i].strip() for l in lignes if i < len(l) and l[i].strip()}
            # On ne garde que ce qui ressemble a un code commune belge (5 chiffres).
            codes = {c for c in codes if re.fullmatch(r"\d{4,5}", c)}
            if codes:
                return nom, codes
    return None, set()


# --------------------------------------------------------------------------
# 3. Les contours, et surtout LE RACCORD
# --------------------------------------------------------------------------

def lire_geojson(corps):
    """Extrait un GeoJSON, eventuellement dans un ZIP."""
    if corps[:2] == b"PK":
        # On prend le PLUS GROS membre geojson, pas le premier : les archives
        # Statbel contiennent aussi de petits .json de metadonnees, et la
        # premiere version tombait dessus puis declarait le tout illisible.
        try:
            archive = zipfile.ZipFile(io.BytesIO(corps))
            membres = [i for i in archive.infolist()
                       if i.filename.lower().endswith((".geojson", ".json"))]
            if not membres:
                return None
            corps = archive.read(max(membres, key=lambda i: i.file_size))
        except Exception:
            return None
    try:
        return json.loads(corps.decode("utf-8", "replace"))
    except Exception:
        return None


def mesurer_contours(nom, geo):
    """Poids brut, poids simplifie, systeme de coordonnees, codes disponibles."""
    entites = geo.get("features") or []
    if not entites:
        journal("      aucune entite")
        return set()
    journal("      entites       : %d  (581 communes belges attendues)" % len(entites))

    proprietes = entites[0].get("properties") or {}
    journal("      proprietes    : %s" % ", ".join(list(proprietes)[:14]))

    # Systeme de coordonnees : la Belgique publie souvent en Lambert 72 (metres),
    # inutilisable tel quel par Leaflet, qui attend des degres.
    def premier_point(geometrie):
        c = geometrie.get("coordinates")
        while isinstance(c, list) and c and isinstance(c[0], list):
            c = c[0]
        return c if isinstance(c, list) and len(c) >= 2 else None

    point = premier_point(entites[0].get("geometry") or {})
    if point:
        degres = abs(point[0]) <= 180 and abs(point[1]) <= 90
        journal("      1er sommet    : %s  -> %s"
                % (point[:2], "degres (WGS84), directement utilisable" if degres
                   else "PROJETE (Lambert ?), reprojection necessaire"))

    brut = len(json.dumps(geo, separators=(",", ":")).encode("utf-8"))
    journal("      poids brut    : %s" % taille(brut))

    # Poids apres la meme simplification que le robot francais : c'est ce qui
    # finirait reellement dans le navigateur.
    # ATTENTION : le seuil du robot francais (EPSILON_DP) est calibre en DEGRES.
    # Applique a des metres, il ne retire presque rien -- la premiere sonde a
    # annonce « 14 % retires » et ce chiffre ne voulait rien dire. On ne mesure
    # donc la simplification que si les coordonnees sont deja en degres.
    if point and not (abs(point[0]) <= 180 and abs(point[1]) <= 90):
        journal("      simplification: non mesuree — coordonnees projetees, le seuil du")
        journal("                      robot est en degres. Reprojeter d'abord.")
        return {c.replace("BE_", "") for c in _codes_de(entites)}
    sommets_avant = sommets_apres = 0
    for entite in entites:
        geometrie = entite.get("geometry") or {}
        coords = geometrie.get("coordinates") or []
        anneaux = []
        if geometrie.get("type") == "Polygon":
            anneaux = coords
        elif geometrie.get("type") == "MultiPolygon":
            anneaux = [a for poly in coords for a in poly]
        for anneau in anneaux:
            if not isinstance(anneau, list) or len(anneau) < 4:
                continue
            sommets_avant += len(anneau)
            try:
                gardes = prep.douglas_peucker_indices(anneau, prep.EPSILON_DP)
                sommets_apres += len(gardes)
            except Exception:
                sommets_apres += len(anneau)
    if sommets_avant:
        journal("      sommets       : %s -> %s apres simplification (%.0f %% retires)"
                % (format(sommets_avant, ",d").replace(",", " "),
                   format(sommets_apres, ",d").replace(",", " "),
                   100 * (1 - sommets_apres / sommets_avant)))
        journal("      poids estime  : ~%s une fois simplifie"
                % taille(int(brut * sommets_apres / sommets_avant)))

    codes = _codes_de(entites)
    if codes:
        journal("      codes commune: %d distincts, ex. %s"
                % (len(codes), sorted(codes)[:4]))
    else:
        journal("      AUCUNE propriete ne ressemble a un code de commune belge")
    return {c.replace("BE_", "") for c in codes}


def _codes_de(entites):
    """Les codes de commune portes par les entites, quelle qu'en soit la clef."""
    proprietes = (entites[0].get("properties") or {}) if entites else {}
    codes = set()
    for cle in proprietes:
        if re.search(r"nis|refnis|cd_munty|lau|insee|code", cle, re.I):
            valeurs = {str((e.get("properties") or {}).get(cle) or "").strip()
                       for e in entites}
            valeurs = {v for v in valeurs if re.fullmatch(r"(BE_)?\d{4,5}", v)}
            if len(valeurs) > len(codes):
                codes = valeurs
    return codes


def raccorder(codes_contours, codes_stats):
    """LE controle qui peut tout arreter : les deux jeux se parlent-ils ?"""
    journal()
    journal("=" * 74)
    journal("LE RACCORD — les contours et les statistiques se parlent-ils ?")
    journal("=" * 74)
    if not codes_contours or not codes_stats:
        journal("  impossible a mesurer : il manque l'un des deux jeux de codes.")
        return
    # Les codes belges s'ecrivent parfois sur 4 chiffres, parfois sur 5 avec un
    # zero de tete. On teste les deux plutot que de conclure trop vite a l'echec.
    def variantes(ensemble):
        sortie = set(ensemble)
        sortie |= {c.zfill(5) for c in ensemble}
        sortie |= {c.lstrip("0") for c in ensemble}
        return sortie
    a, b = variantes(codes_contours), variantes(codes_stats)
    communs = a & b
    journal("  codes de contours     : %d" % len(codes_contours))
    journal("  codes de statistiques : %d" % len(codes_stats))
    journal("  RACCORDES             : %d" % len(communs))
    if codes_contours:
        journal("  soit %.1f %% des contours et %.1f %% des statistiques"
                % (100 * len(communs) / len(variantes(codes_contours)),
                   100 * len(communs) / max(1, len(variantes(codes_stats)))))
    orphelins = sorted(variantes(codes_contours) - b)[:6]
    if orphelins:
        journal("  contours sans statistique, ex. : %s" % ", ".join(orphelins))
    if len(communs) < 0.9 * COMMUNES_BELGES:
        journal("  -> INSUFFISANT en l'etat : une carte trouee n'a pas d'interet.")
    else:
        journal("  -> le raccord tient.")


# --------------------------------------------------------------------------
# 4. Ce que la carte montrerait vraiment
# --------------------------------------------------------------------------

def couverture(colonnes, lignes):
    """Que montrerait la carte : combien d'entites coloriees, combien de grises ?

    CORRECTION D'UN FAUX RAPPORT. La premiere version comptait des SECTEURS
    STATISTIQUES en les appelant des communes, et annoncait « 659 % des 581
    communes belges » -- un pourcentage impossible qui aurait du m'alerter
    immediatement. On distingue desormais les deux, et on nomme ce qu'on compte.
    """
    journal()
    journal("=" * 74)
    journal("LA CARTE — combien d'entites seraient reellement coloriees ?")
    journal("=" * 74)
    icode = imed = inb = iannee = None
    par_secteur = False
    for i, nom in enumerate(colonnes):
        if icode is None and re.search(r"stat_?sector|cd_sector", nom, re.I):
            icode, par_secteur = i, True
        if icode is None and re.search(r"refnis|cd_munty|nis[_ ]?code", nom, re.I):
            icode = i
        if imed is None and re.search(r"median|mediaan|mediane|p50", nom, re.I):
            imed = i
        if inb is None and re.search(r"transaction|aantal|nombre|number|count", nom, re.I):
            inb = i
        if iannee is None and re.search(r"year|jaar|annee", nom, re.I):
            iannee = i
    if icode is None or imed is None:
        journal("  colonnes de code ou de mediane introuvables (code=%s, mediane=%s)."
                % (icode, imed))
        return
    quoi = "secteurs statistiques" if par_secteur else "communes"
    journal("  granularite : %s  (colonnes %s / %s)"
            % (quoi, colonnes[icode], colonnes[imed]))

    # Une seule annee : melanger douze millesimes gonfle artificiellement le
    # nombre d'entites, les codes ayant change au fil des fusions de communes.
    annees = sorted({l[iannee] for l in lignes if iannee is not None
                     and iannee < len(l) and l[iannee].strip()}) if iannee is not None else []
    derniere = annees[-1] if annees else None
    if derniere:
        journal("  annee retenue : %s (sur %d disponibles)" % (derniere, len(annees)))

    avec, tous, prix, transactions = set(), set(), [], 0
    for ligne in lignes:
        if icode >= len(ligne):
            continue
        if derniere and iannee < len(ligne) and ligne[iannee] != derniere:
            continue
        code = ligne[icode].strip()
        if not code:
            continue
        tous.add(code)
        brut = ligne[imed].strip() if imed < len(ligne) else ""
        try:
            valeur = float(brut.replace(",", ".").replace(" ", "")) if brut else 0
        except ValueError:
            valeur = 0
        if valeur > 0:
            avec.add(code)
            prix.append(valeur)
            if inb is not None and inb < len(ligne):
                try:
                    transactions += int(float(ligne[inb] or 0))
                except ValueError:
                    pass
    journal("  %s presents dans le fichier : %d" % (quoi, len(tous)))
    journal("  %s avec un prix median      : %d  (%.1f %%)"
            % (quoi, len(avec), 100 * len(avec) / max(1, len(tous))))
    journal("  %s sans (sous le seuil)     : %d" % (quoi, len(tous) - len(avec)))
    if par_secteur:
        communes = {c[:5] for c in avec}
        journal("  -> communes touchees par au moins un secteur chiffre : %d sur %d (%.1f %%)"
                % (len(communes), COMMUNES_BELGES,
                   100 * len(communes) / COMMUNES_BELGES))
    if transactions:
        journal("  transactions couvertes     : %s"
                % format(transactions, ",d").replace(",", " "))
    if prix:
        prix.sort()
        def q(p):
            return prix[min(len(prix) - 1, int(p * len(prix)))]
        journal("  prix medians : min %s | Q1 %s | median %s | Q3 %s | max %s"
                % tuple(format(int(x), ",d").replace(",", " ") + " EUR"
                        for x in (prix[0], q(0.25), q(0.5), q(0.75), prix[-1])))
        seuils = [q(k / 9) for k in range(1, 9)]
        journal("  9 classes donneraient : %s"
                % ", ".join(format(int(s), ",d").replace(",", " ") for s in seuils))


# --------------------------------------------------------------------------
# Programme principal
# --------------------------------------------------------------------------

def classer(nom, corps):
    """Tableau, geometrie, ou autre chose ? On regarde le contenu, pas le nom."""
    tete = corps[:4]
    if tete[:2] == b"PK":
        try:
            noms = zipfile.ZipFile(io.BytesIO(corps)).namelist()
        except Exception:
            return "illisible"
        if any(n.lower().endswith((".geojson", ".shp")) for n in noms):
            return "geometrie"
        if any(n.lower().endswith((".csv", ".txt", ".tsv")) for n in noms):
            return "tableau"
        return "archive (%s)" % ", ".join(noms[:3])
    apercu = corps[:600].decode("utf-8", "replace")
    if '"FeatureCollection"' in apercu or '"features"' in apercu:
        return "geometrie"
    if apercu.lstrip()[:1] in "{[":
        return "json"
    if "<" in apercu[:60] and "html" in apercu[:400].lower():
        return "page HTML"
    return "tableau"


def explorer(pages, sujet, deja_vues):
    """Ouvre des pages et en extrait les liens de telechargement du sujet voulu."""
    trouves = []
    for nom, url in pages:
        if url in deja_vues:
            continue
        deja_vues.add(url)
        reponse = lire_url(url, delai=45)
        if reponse["statut"] != 200:
            journal("  %-52s %s" % (nom[:52], reponse["erreur"] or "sans reponse"))
            continue
        liens = extraire_liens(url, reponse["corps"], sujet)
        journal()
        journal("  %s" % nom)
        if not liens:
            journal("      aucun lien de telechargement repere")
            continue
        for lien in liens[:5]:
            journal("      %s" % lien[-96:])
        if len(liens) > 5:
            journal("      … et %d autres" % (len(liens) - 5))
        trouves.extend(liens)
    return trouves


def main():
    analyseur = argparse.ArgumentParser(description=__doc__)
    analyseur.add_argument("--verrou-seulement", action="store_true",
                           help="n'executer que le controle de gratuite")
    analyseur.add_argument("--sans-contours", action="store_true",
                           help="sauter la geometrie (la question des ventes suffit)")
    analyseur.add_argument("--max-fichiers", type=int, default=6,
                           help="nombre maximal de fichiers de ventes a ouvrir")
    options = analyseur.parse_args()

    journal("SONDE BELGIQUE — mesure de faisabilite d'une carte des prix")
    journal("Ce script ne modifie AUCUN fichier du depot.")
    journal()

    verrou_gratuite(PAGES + PAGES_GEOMETRIE + DIRECTS)
    if options.verrou_seulement:
        return 0

    # --- 1. LES VENTES, d'abord : c'est la question centrale --------------
    journal()
    journal("=" * 74)
    journal("DECOUVERTE — les fichiers de VENTES")
    journal("=" * 74)
    vues = set()
    liens_ventes = explorer(PAGES, LIEN_VENTES, vues)

    journal()
    journal("=" * 74)
    journal("CONTENU — que contiennent les fichiers de ventes ?")
    journal("=" * 74)
    codes_stats, meilleur = set(), None
    ouverts = 0
    for lien in liens_ventes:
        if ouverts >= options.max_fichiers or budget_epuise():
            journal()
            journal("  arret : %s" % (budget_epuise() or "plafond de fichiers atteint"))
            break
        reponse = lire_url(lien)
        if reponse["statut"] != 200 or not reponse["corps"]:
            continue
        ouverts += 1
        corps = reponse["corps"]
        journal()
        journal("  %s" % lien[-96:])
        journal("      %s  —  %s" % (classer(lien, corps), taille(len(corps))))
        tableaux = lire_tableau(corps, lien)
        if not tableaux:
            journal("      pas un tableau lisible")
            continue
        for tableau in tableaux[:2]:
            colonnes, lignes = decrire_tableau(tableau)
            cle, codes = codes_de_commune(colonnes, lignes)
            if codes:
                journal("      codes commune (%s) : %d distincts" % (cle, len(codes)))
                if len(codes) > len(codes_stats):
                    codes_stats, meilleur = codes, (colonnes, lignes)

    # --- 2. LA GEOMETRIE, ensuite, et UN SEUL fichier ---------------------
    codes_contours = set()
    if not options.sans_contours and not budget_epuise():
        journal()
        journal("=" * 74)
        journal("DECOUVERTE — la geometrie des communes")
        journal("=" * 74)
        # Ses propres URL vues : le catalogue sert aux DEUX passes, et le
        # partager empechait la geometrie d'etre decouverte du tout.
        liens_geo = explorer(PAGES_GEOMETRIE, LIEN_GEOMETRIE, set())
        # Un seul, en degres si possible : 4326 plutot que le Lambert 31370.
        liens_geo.sort(key=lambda u: (0 if "4326" in u or "3812" in u else 1, len(u)))
        for lien in liens_geo[:1]:
            reponse = lire_url(lien)
            if reponse["statut"] != 200 or not reponse["corps"]:
                continue
            journal()
            journal("  %s" % lien[-96:])
            journal("      %s" % taille(len(reponse["corps"])))
            geo = lire_geojson(reponse["corps"])
            if not geo:
                journal("      illisible comme GeoJSON")
                continue
            codes_contours = mesurer_contours(lien, geo)

    raccorder(codes_contours, codes_stats)
    if meilleur:
        couverture(*meilleur)

    journal()
    journal("=" * 74)
    journal("Total telecharge : %s en %.0f s. Aucun fichier du depot modifie."
            % (taille(_octets), time.time() - _depart))
    return 0


if __name__ == "__main__":
    sys.exit(main())
