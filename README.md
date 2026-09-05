# Immo — Occitanie, PACA & Rhône-Alpes

Un site web qui montre **les vraies ventes de maisons** enregistrées dans
**21 départements du sud de la France**, sur une carte, et qui **estime un bien**
à partir de ces ventes.

Alpes-de-Haute-Provence (04), Hautes-Alpes (05), Alpes-Maritimes (06), Ardèche (07), Ariège (09), Aude (11), Aveyron (12), Bouches-du-Rhône (13), Drôme (26), Gard (30), Haute-Garonne (31), Gers (32), Hérault (34), Lot (46), Lozère (48), Hautes-Pyrénées (65), Pyrénées-Orientales (66), Tarn (81), Tarn-et-Garonne (82), Var (83), Vaucluse (84)

- À gauche : les 21 départements, chacun avec son **prix médian au m²** et son
  nombre de ventes — la vue d'ensemble du marché, lisible sans rien déplier.
  Cliquez sur un département pour voir ses communes ; la recherche, elle,
  fouille les 3 945 communes d'un coup.
- Au milieu : une carte. De loin, les communes sont **coloriées** selon leur prix au m².
  En zoomant (ou en cliquant une commune), les **ventes apparaissent une par une**.
- À droite : la fiche de la commune et l'**estimateur**.

---

## 1. Les trois choses à faire une seule fois

Tout se passe sur github.com, dans ce dépôt. Il n'y a rien à installer.

### ① Rendre le dépôt public
`Settings` → tout en bas, `Danger Zone` → `Change repository visibility` → **Public**.

*Pourquoi ?* L'hébergement gratuit de GitHub ne fonctionne que sur les dépôts publics.
Rien de confidentiel ne devient visible : les données viennent de l'État et sont déjà
publiques. L'adresse du site ne sera connue que de vous, sauf si vous la partagez.

### ② Allumer le site
`Settings` → `Pages` → `Source` : choisir **Deploy from a branch**, puis
la branche **main** et le dossier **/ (root)**. Enregistrer.

Au bout de 2-3 minutes, le site est en ligne à l'adresse
`https://pmeyssonnier.github.io/Immo/`.

### ③ Charger les vraies données
Onglet **Actions** → dans la colonne de gauche, **« Mise à jour des données DVF »**
→ bouton **Run workflow** → **Run workflow**.

Le robot travaille environ 10 minutes : il télécharge les ventes des 5 dernières
années, les nettoie et les range. Le site se met à jour tout seul juste après.

> Tant que cette étape n'est pas faite, le site affiche un **bandeau orange** :
> les prix visibles sont des données de démonstration **inventées**, uniquement
> destinées à mettre le site au point.

Ensuite, le robot repasse tout seul **le 5 de chaque mois**. Vous n'avez plus rien à faire.

> **Autre moyen de le relancer**, si le bouton n'est pas accessible : modifiez le
> fichier `.github/declencher-donnees.txt` (écrivez-y la date du jour, puis
> `Commit changes`). Toute modification de ce fichier réveille le robot.

---

## 2. Comment s'en servir

1. Tapez le début d'un nom dans la case de recherche (les accents n'ont pas
   d'importance : « nimes » trouve « Nîmes »).
2. Cliquez la commune : la carte s'y rend et les ventes apparaissent.
3. Cliquez un point de la carte : adresse, date, prix, surface, terrain.
4. Dans le panneau de droite, saisissez la **surface habitable** (et si vous les
   connaissez le **terrain** et le **nombre de pièces**), puis **Estimer**.
5. Le bouton **Copier la synthèse** met un résumé dans le presse-papier, prêt à
   coller dans un avis de valeur.

### Mettre l'application sur l'écran d'accueil du téléphone
Ouvrez l'adresse du site sur votre téléphone, puis :
- **iPhone** (Safari) : bouton Partager <kbd>⬆︎</kbd> → *Sur l'écran d'accueil* ;
- **Android** (Chrome) : menu <kbd>⋮</kbd> → *Ajouter à l'écran d'accueil*.

L'icône est une maison blanche et orange sur fond bleu, et le nom affiché est
**Ventes DVF**. Le raccourci ouvre l'application en plein écran, sans la barre
d'adresse — ce qui rend la carte nettement plus lisible.

> Chrome n'affichera **pas** de bandeau « Installer l'application » : cela
> demanderait un mécanisme de fonctionnement hors ligne, que le site n'a pas.
> Passez par le menu, comme ci-dessus.

### Ce que veulent dire les chiffres

- **Estimation** : la valeur la plus probable, arrondie.
- **Fourchette** : la marge d'incertitude *sur cette estimation*. Elle ne descend
  jamais sous ±4 % (annoncer mieux serait une fausse précision) et ne dépasse
  jamais ±12 %.
- **Dispersion du marché local** : à quel point les biens de la commune sont
  hétérogènes. **Ce n'est pas la même chose que la fourchette** — c'est la
  diversité réelle des maisons du secteur.
- **Fiabilité** : *Bonne* / *Moyenne* / *Faible*. S'il n'y a vraiment pas assez de
  ventes, le site **refuse d'afficher un chiffre** plutôt que d'en inventer un.

---

## 3. Comment l'estimation est calculée (en clair)

1. On récupère toutes les ventes de maisons de la commune.
2. On écarte celles dont la surface est trop éloignée (plus du double, ou moins
   de la moitié).
3. On **remet chaque ancien prix au niveau d'aujourd'hui**, grâce à un indice
   calculé sur les ventes du département.
4. On donne à chaque vente un **poids**, d'autant plus fort qu'elle est :
   dans la même commune, de surface proche, récente, avec un nombre de pièces et
   un terrain comparables.
5. On prend la **médiane pondérée** du prix au m², qu'on multiplie par votre surface.
6. Si la commune n'a pas assez de ventes, on élargit **aux communes limitrophes**
   (et le site vous le dit). En dernier recours, on utilise les moyennes du
   département par tranche de surface.

Une estimation portée surtout par les communes voisines n'obtient **jamais** mieux
que « fiabilité faible », même si ces voisines fournissent des centaines de ventes.

---

## 4. Ce que ces chiffres ne savent pas

**L'ajustement selon le terrain est volontairement grossier.** La case est
décochée par défaut. Le prix du mètre carré de terrain est calculé à l'échelle
du **département**, jamais de la commune : mesure faite, avec quelques centaines
de ventes le chiffre varie du simple au décuple selon l'échantillon. Il faut
plusieurs milliers de ventes pour qu'il se stabilise — ce qu'aucune commune
n'atteint, mais que les départements atteignent largement.

**Et dans certains départements, la case n'apparaît pas du tout.** Trois cas
mesurés : Alpes-Maritimes (−5 €/m²), Var (−16 €/m²) et Haute-Garonne
(0,85 €/m²). Les deux premiers sont *négatifs* et le troisième est négligeable —
2 500 m² de terrain en plus n'y ajouteraient que 2 100 €.

Ce ne sont pas des erreurs de calcul. Une fois la valeur du bâti retirée, les
grands terrains se trouvent dans l'arrière-pays, moins cher, tandis que la prime
va au littoral ou à la proximité de la ville, sur de petites parcelles. La
surface de terrain n'y explique pas le prix. L'application préfère ne rien
proposer plutôt qu'avancer un chiffre qui serait plus petit que sa propre marge
d'erreur.

DVF enregistre le prix, l'adresse et les surfaces — **rien d'autre**. Le fichier
ignore l'état du bien, les travaux, l'exposition, la vue, le DPE, le bruit.
Une maison rénovée et une passoire thermique de même surface y figurent au même titre.

C'est une **aide à la décision**, pas un avis de valeur signé. Votre connaissance
du terrain reste indispensable.

---

## 5. Questions fréquentes

**J'ai double-cliqué sur `index.html` et la page affiche une erreur.**
C'est normal, et ce n'est pas un défaut de l'application : votre navigateur
interdit à une page ouverte depuis un fichier local de lire les fichiers voisins.
Utilisez l'adresse du site en ligne. (Pour travailler hors ligne : ouvrez un
terminal dans ce dossier, tapez `python3 -m http.server 8000`, puis allez sur
`http://localhost:8000`.)

**La carte est vide / il n'y a que des contours gris.**
Le fond de plan (OpenStreetMap) n'a pas pu se charger. Un message vous le signale
en bas à gauche. Les contours et les couleurs, eux, viennent de nos propres
fichiers et restent utilisables.

**Une commune est grise.**
Moins de 5 ventes de maison y ont été enregistrées sur la période : aucune
statistique honnête n'est calculable. C'est fréquent dans les villages de
montagne ardéchois.

**J'ai changé l'icône mais mon téléphone affiche encore l'ancienne.**
Normal : iOS **fige** l'icône au moment où le raccourci est créé et ne la met
jamais à jour ensuite. Supprimez le raccourci de l'écran d'accueil et
recréez-le. Même logique dans les navigateurs, qui gardent les favicons
plusieurs jours dans une réserve à part. Si l'icône doit changer un jour, le
plus sûr est de **renommer le fichier** (par exemple `icone-2.png`) plutôt que
d'ajouter `?v=2` derrière son nom.

**Tous les workflows échouent en 0 seconde (« startup_failure »).**
Cela arrive typiquement après un changement de visibilité du dépôt : GitHub
réinitialise la politique des actions autorisées, et même les actions
officielles se retrouvent bloquées. Les workflows de ce dépôt ont été écrits
**sans aucune action externe** justement pour y être insensibles. Si le
problème réapparaît malgré tout : `Settings` → `Actions` → `General` →
**Actions permissions** → *Allow all actions and reusable workflows* → `Save`.

**Le robot a échoué (croix rouge dans l'onglet Actions).**
Il refuse volontairement de publier des données incohérentes. Ouvrez le
détail : le rapport indique quel contrôle a échoué. Vous pouvez relancer
« Run workflow » : les données précédentes restent en place entre-temps.

---

## 6. Pour les curieux : ce qu'il y a dans le dépôt

| Dossier | À quoi ça sert |
|---|---|
| `index.html`, `css/`, `js/` | le site lui-même |
| `js/estimation.js` | l'algorithme d'estimation, isolé et commenté |
| `data/` | les données préparées (produites par le robot) |
| `scripts/preparer_donnees.py` | le robot qui télécharge et nettoie DVF |
| `scripts/generer_demo.py` | fabrique le jeu de démonstration |
| `icones/` + `manifest.json` | l'icône de l'application et sa fiche d'identité (nom affiché, couleurs) |
| `scripts/generer_icones.mjs` | redessine les icônes — **à ne jamais lancer**, les fichiers sont déjà là |
| `vendor/` | Leaflet (la bibliothèque de carte), figée dans le dépôt |
| `tests/` | les vérifications automatiques |
| `.github/workflows/` | le robot mensuel et les tests |

### Lancer les vérifications
```bash
python -m unittest discover tests     # nettoyage DVF, contours, site
node --test tests/test_estimation.mjs # algorithme d'estimation
```

### Vérification visuelle (facultative, demande un navigateur)
```bash
npm install playwright-core
python3 -m http.server 8321 &
node tests/verification_navigateur.mjs
```

---

## 7. Liste de contrôle avant de faire confiance à l'outil

1. La carte s'affiche, les communes sont coloriées, la légende est en bas à droite.
2. Taper « Uzès » → une seule ligne ; cliquer → la carte zoome, des points apparaissent.
3. Cliquer un point → adresse, date, prix, surface.
4. Estimer 120 m² / 600 m² / 5 pièces à Uzès → un montant plausible, une fiabilité,
   dix ventes comparables.
5. Choisir une petite commune de montagne ardéchoise → le site doit dire
   « données insuffisantes » ou afficher une fiabilité faible, **et non un chiffre fantaisiste**.
6. **Le seul test qui compte vraiment** : comparer trois estimations à trois ventes
   que vous connaissez réellement.

### Et sur le téléphone (5 points, une seule fois)
Ces cinq points ne peuvent être vérifiés que sur un vrai téléphone — aucun test
automatique ne les couvre.
1. Ouvrir l'adresse du site sur le téléphone.
2. L'ajouter à l'écran d'accueil (voir la section 2).
3. L'icône est bien une **maison blanche au toit orange sur fond bleu** — ni carré
   noir, ni bord noir autour, ni anneau blanc.
4. Le nom sous l'icône est **Ventes DVF**, sans être coupé.
5. En ouvrant le raccourci, il n'y a **pas de barre d'adresse** : la carte occupe
   tout l'écran.

Voir aussi [MENTIONS-LEGALES.md](MENTIONS-LEGALES.md).
