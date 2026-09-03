# -*- coding: utf-8 -*-
"""Fabrique tests/fixtures/dvf_echantillon.csv (jeu de test volontairement pieges)."""
import csv, json, math

COLS = ["id_mutation","date_mutation","numero_disposition","nature_mutation","valeur_fonciere",
        "adresse_numero","adresse_suffixe","adresse_nom_voie","adresse_code_voie","code_postal",
        "code_commune","nom_commune","code_departement","id_parcelle","numero_volume","lot1_numero",
        "nombre_lots","code_type_local","type_local","surface_reelle_bati",
        "nombre_pieces_principales","code_nature_culture","nature_culture","surface_terrain",
        "longitude","latitude"]

lignes = []
def L(idm, date, nature, valeur, commune, nom, dep, parcelle, type_local, sbati,
      pieces, sterr, lon, lat, lots="", numero="12", voie="RUE DES LICES", cp="30000"):
    lignes.append({
        "id_mutation": idm, "date_mutation": date, "numero_disposition": "1",
        "nature_mutation": nature, "valeur_fonciere": valeur,
        "adresse_numero": numero, "adresse_suffixe": "", "adresse_nom_voie": voie,
        "adresse_code_voie": "0123", "code_postal": cp,
        "code_commune": commune, "nom_commune": nom, "code_departement": dep,
        "id_parcelle": parcelle, "numero_volume": "", "lot1_numero": "",
        "nombre_lots": lots, "code_type_local": "1" if type_local == "Maison" else "",
        "type_local": type_local, "surface_reelle_bati": sbati,
        "nombre_pieces_principales": pieces, "code_nature_culture": "S" if sterr else "",
        "nature_culture": "sols" if sterr else "", "surface_terrain": sterr,
        "longitude": lon, "latitude": lat})

NIM, NOM_NIM, LON_NIM, LAT_NIM = "30189", "Nîmes", "4.3601", "43.8367"
PRI, NOM_PRI, LON_PRI, LAT_PRI = "07186", "Privas", "4.5990", "44.7350"

# --- CAS 1 : mutation sur 3 lignes, valeur_fonciere REPETEE -----------------
# Attendu : 1 vente a 240000 EUR (et surtout PAS 720000).
for i in range(3):
    L("C1", "2024-03-15", "Vente", "240000", NIM, NOM_NIM, "30", "30189000AB0001",
      "Maison" if i == 0 else "", "120" if i == 0 else "", "5" if i == 0 else "",
      "600", LON_NIM, LAT_NIM)

# --- CAS 2 : vente mixte maison + appartement -> rejet R2 -------------------
L("C2", "2024-04-01", "Vente", "500000", NIM, NOM_NIM, "30", "30189000AB0002", "Maison", "100", "4", "300", LON_NIM, LAT_NIM)
L("C2", "2024-04-01", "Vente", "500000", NIM, NOM_NIM, "30", "30189000AB0002", "Appartement", "60", "3", "0", LON_NIM, LAT_NIM)

# --- CAS 3 : terrain REPETE sur plusieurs lignes de la MEME parcelle --------
# Attendu : terrain = 800 (et non 2400).
for _ in range(3):
    L("C3", "2024-05-10", "Vente", "310000", NIM, NOM_NIM, "30", "30189000AB0003",
      "", "", "", "800", LON_NIM, LAT_NIM)
L("C3", "2024-05-10", "Vente", "310000", NIM, NOM_NIM, "30", "30189000AB0003", "Maison", "140", "6", "800", LON_NIM, LAT_NIM)

# --- CAS 4 : maison + 3 parcelles de terrain attenantes distinctes ----------
# Attendu : conservee, terrain = 500 + 200 + 300 + 400 = 1400.
L("C4", "2024-06-20", "Vente", "295000", NIM, NOM_NIM, "30", "30189000AC0001", "Maison", "110", "5", "500", LON_NIM, LAT_NIM)
for parcelle, terrain in [("30189000AC0002", "200"), ("30189000AC0003", "300"), ("30189000AC0004", "400")]:
    L("C4", "2024-06-20", "Vente", "295000", NIM, NOM_NIM, "30", parcelle, "", "", "", terrain, LON_NIM, LAT_NIM)

# --- CAS 5 : deux maisons sur des parcelles distinctes -> rejet R3 ----------
L("C5", "2024-07-01", "Vente", "600000", NIM, NOM_NIM, "30", "30189000AD0001", "Maison", "100", "4", "400", LON_NIM, LAT_NIM)
L("C5", "2024-07-01", "Vente", "600000", NIM, NOM_NIM, "30", "30189000AD0002", "Maison", "90", "4", "350", LON_NIM, LAT_NIM)

# --- CAS 6 : prix a 0 -> rejet par les bornes ------------------------------
L("C6", "2024-07-15", "Vente", "0", NIM, NOM_NIM, "30", "30189000AE0001", "Maison", "100", "4", "300", LON_NIM, LAT_NIM)

# --- CAS 7 : surface batie absente -> rejet R7 -----------------------------
L("C7", "2024-08-01", "Vente", "250000", NIM, NOM_NIM, "30", "30189000AE0002", "Maison", "", "4", "300", LON_NIM, LAT_NIM)

# --- CAS 8 : 45 000 EUR/m2 -> rejet par les bornes -------------------------
L("C8", "2024-08-10", "Vente", "900000", NIM, NOM_NIM, "30", "30189000AE0003", "Maison", "20", "1", "0", LON_NIM, LAT_NIM)

# --- CAS 9 : mutation a cheval sur deux communes -> rejet R5 ---------------
L("C9", "2024-09-01", "Vente", "400000", NIM, NOM_NIM, "30", "30189000AF0001", "Maison", "120", "5", "500", LON_NIM, LAT_NIM)
L("C9", "2024-09-01", "Vente", "400000", "30032", "Alès", "30", "30032000AF0002", "", "", "", "900", "4.0800", "44.1280")

# --- CAS 10 : VEFA -> rejet R1 --------------------------------------------
L("C10", "2024-09-15", "Vente en l'état futur d'achèvement", "280000", NIM, NOM_NIM, "30", "30189000AG0001", "Maison", "95", "4", "250", LON_NIM, LAT_NIM)

# --- CAS 11 : lot de copropriete (nombre_lots = 3) -> rejet R4 -------------
L("C11", "2024-10-01", "Vente", "320000", NIM, NOM_NIM, "30", "30189000AG0002", "Maison", "105", "5", "0", LON_NIM, LAT_NIM, lots="3")

# --- CAS 12 : pas de coordonnees GPS -> rejet R6 --------------------------
L("C12", "2024-10-10", "Vente", "260000", NIM, NOM_NIM, "30", "30189000AG0003", "Maison", "100", "4", "300", "", "")

# --- CAS 13 : maison + dependance (garage) -> CONSERVEE -------------------
L("C13", "2024-11-05", "Vente", "270000", NIM, NOM_NIM, "30", "30189000AH0001", "Maison", "115", "5", "450", LON_NIM, LAT_NIM)
L("C13", "2024-11-05", "Vente", "270000", NIM, NOM_NIM, "30", "30189000AH0001", "Dépendance", "18", "0", "450", LON_NIM, LAT_NIM)

# --- CAS 14 : valeur aberrante isolee, eliminee par la MAD ----------------
# 100 m2 a 750 000 EUR = 7500 EUR/m2 : dans les bornes absolues, mais tres loin
# du marche nimois de l'echantillon -> doit sauter a l'etage MAD.
L("C14", "2024-11-20", "Vente", "750000", NIM, NOM_NIM, "30", "30189000AH0002", "Maison", "100", "4", "300", LON_NIM, LAT_NIM)

# --- Ventes ordinaires : de quoi calculer des statistiques ----------------
# Nimes : 12 ventes autour de 2000 EUR/m2, etalees sur 5 ans.
NIMES_OK = [(2020,"01",95,147000,350),(2020,"06",130,218000,700),(2021,"03",110,197000,500),
            (2021,"09",145,273000,900),(2022,"02",88,172000,220),(2022,"08",120,241000,610),
            (2023,"04",160,333000,1200),(2023,"11",102,219000,400),(2024,"01",135,305000,800),
            (2024,"07",78,187000,180),(2025,"02",118,302000,560),(2025,"06",150,412000,1000)]
for i, (an, mois, s, p, terr) in enumerate(NIMES_OK):
    L("N%02d" % i, "%d-%s-12" % (an, mois), "Vente", str(p), NIM, NOM_NIM, "30",
      "30189000BA%04d" % i, "Maison", str(s), str(max(2, s // 25)), str(terr),
      "%.5f" % (4.3601 + i * 0.0012), "%.5f" % (43.8367 + i * 0.0009),
      numero=str(10 + i), voie="RUE DES LICES")

# Privas : 8 ventes autour de 1550 EUR/m2.
PRIVAS_OK = [(2021,"05",100,125000,800),(2021,"11",120,166000,1400),(2022,"04",90,133000,600),
             (2022,"10",140,217000,2000),(2023,"06",110,178000,950),(2024,"02",130,221000,1600),
             (2024,"09",95,173000,700),(2025,"03",125,244000,1100)]
for i, (an, mois, s, p, terr) in enumerate(PRIVAS_OK):
    L("P%02d" % i, "%d-%s-08" % (an, mois), "Vente", str(p), PRI, NOM_PRI, "07",
      "07186000BA%04d" % i, "Maison", str(s), str(max(2, s // 25)), str(terr),
      "%.5f" % (4.5990 + i * 0.0015), "%.5f" % (44.7350 + i * 0.0011),
      numero=str(3 + i), voie="AVENUE DE L EUROPE", cp="07000")

with open("tests/fixtures/dvf_echantillon.csv", "w", encoding="utf-8", newline="") as f:
    w = csv.DictWriter(f, fieldnames=COLS)
    w.writeheader()
    w.writerows(lignes)
print("lignes ecrites :", len(lignes))

# --- Contours de test : deux communes PARTAGEANT une frontiere SINUEUSE ----
# La frontiere doit onduler : sur un bord parfaitement droit, Douglas-Peucker
# ne garderait (a juste titre) que les 2 extremites, et le test ne prouverait
# rien. Avec des ondulations, il conserve des sommets intermediaires -- et on
# peut alors verifier qu'ils sont IDENTIQUES des deux cotes de la frontiere.
def frontiere_sinueuse(x, y0, y1, n=60, amplitude=0.012):
    pts = []
    for i in range(n + 1):
        y = y0 + (y1 - y0) * i / n
        pts.append([round(x + amplitude * math.sin(i * 0.7), 6), round(y, 6)])
    return pts

FRONT = frontiere_sinueuse(4.42, 43.80, 43.88)

def cote(x0, y0, y1, n=30):
    """Bord vertical droit, subdivise."""
    return [[x0, round(y0 + (y1 - y0) * i / n, 6)] for i in range(n + 1)]

# commune ouest : bas -> frontiere (vers le haut) -> haut -> bord gauche (vers le bas)
ouest = ([[4.30, 43.80]] + FRONT + [[4.30, 43.88]]
         + list(reversed(cote(4.30, 43.80, 43.88)))[1:-1] + [[4.30, 43.80]])
# commune est : memes points de frontiere, puis contourne par la droite
est = (FRONT + [[4.54, 43.88]] + list(reversed(cote(4.54, 43.80, 43.88)))[1:-1]
       + [[4.54, 43.80]] + [FRONT[0]])

geo = {"type": "FeatureCollection", "features": [
    {"type": "Feature", "properties": {"code": "30189", "nom": "Nîmes"},
     "geometry": {"type": "Polygon", "coordinates": [ouest]}},
    {"type": "Feature", "properties": {"code": "30032", "nom": "Alès"},
     "geometry": {"type": "Polygon", "coordinates": [est]}},
    {"type": "Feature", "properties": {"code": "07186", "nom": "Privas"},
     "geometry": {"type": "Polygon", "coordinates": [
         [[4.55, 44.70], [4.65, 44.70], [4.65, 44.78], [4.55, 44.78], [4.55, 44.70]]]}},
]}
with open("tests/fixtures/communes_test.geojson", "w", encoding="utf-8") as f:
    json.dump(geo, f, ensure_ascii=False)
print("contours de test ecrits")
