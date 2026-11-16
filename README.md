# Quiz Live

Quiz en direct : les joueurs rejoignent avec leur téléphone en scannant un QR code, l'animateur pilote depuis un PC, et un écran de projection affiche les questions.

**Aucune dépendance** : il suffit de Node.js 18 ou plus récent.

## Lancer

```
node server.js
```

ou double-cliquer sur `Lancer-Quiz.bat` (Windows). Ensuite :

| Page | Adresse | Pour qui |
|---|---|---|
| Gestion | http://localhost:3000/host | l'animateur (PC) |
| Projection | bouton « Ouvrir l'écran de projection » dans Gestion | vidéoprojecteur / TV |
| Joueur | QR code ou `http://<IP-du-PC>:3000/play` | téléphones |

### Jouer depuis n'importe où (4G, autre Wi-Fi) — mode Internet

Lancez `Lancer-Quiz-Internet.bat` (ou `node server.js --internet`). Le serveur ouvre un **tunnel Cloudflare gratuit et sans compte** et le QR code pointe vers une adresse du type `https://xxxx.trycloudflare.com` accessible depuis n'importe quel téléphone connecté à Internet.

Prérequis, à installer une seule fois : l'outil `cloudflared`

```
winget install --id Cloudflare.cloudflared
```

(ou déposez `cloudflared.exe` directement dans ce dossier). L'adresse change à chaque lancement : rien à faire, le QR code est mis à jour automatiquement. Si le tunnel ne peut pas s'ouvrir, l'app continue en mode Wi-Fi local et l'indique dans la page de gestion.

### Mode Wi-Fi local

Avec `Lancer-Quiz.bat` / `node server.js`, les téléphones doivent être sur **le même réseau Wi-Fi** que le PC. Au premier lancement, Windows peut demander d'autoriser Node.js dans le pare-feu : acceptez pour les réseaux privés.

### Créer un Wi-Fi avec le PC (point d'accès)

Si le PC est branché en câble Ethernet, il peut créer son propre Wi-Fi et le partager :
**Paramètres → Réseau et Internet → Point d'accès sans fil mobile**, partager « Ethernet » via « Wi-Fi », puis activer.
Les téléphones s'y connectent (ils gardent Internet) et l'app met automatiquement l'adresse du point d'accès (`192.168.137.1`) dans le QR code. Lancez simplement `Lancer-Quiz.bat`.

- Limite Windows : **8 appareils maximum**. Au-delà, utilisez le mode Internet.
- Si les téléphones n'arrivent pas à charger la page, autorisez Node.js sur les réseaux **publics** dans le pare-feu Windows (le réseau du point d'accès est souvent classé « public »).

### Autres réglages (variables d'environnement)

- `PUBLIC_URL` : adresse mise dans le QR code (ex. `https://quiz.mondomaine.fr`). La définir active le **mode hébergé** (voir plus bas).
- `PORT` : port d'écoute (3000 par défaut).
- `HOST` : interface d'écoute (`0.0.0.0` par défaut = tout le réseau ; `127.0.0.1` = seulement la machine elle-même, à utiliser derrière un serveur web).
- `ADMIN_PASSWORD` : voir ci-dessous.
- `HOSTED` : `0` désactive le mode hébergé même si `PUBLIC_URL` est défini (utile si vous ne vous servez de `PUBLIC_URL` que pour corriger l'IP du QR code sur votre PC).

## Héberger sur un serveur avec un nom de domaine

L'app doit tourner **en continu sur une seule machine** (les parties sont en mémoire) : un petit VPS Linux convient, pas un hébergement « serverless ».

1. DNS : un enregistrement **A** `quiz.mondomaine.fr` → IP du serveur.
2. Copier le dossier dans `/opt/quiz` et installer Node.js 18+ et [Caddy](https://caddyserver.com) (HTTPS automatique). `/etc/caddy/Caddyfile` :
   ```
   quiz.mondomaine.fr {
       reverse_proxy 127.0.0.1:3000
   }
   ```
3. Service `/etc/systemd/system/quiz.service` :
   ```
   [Unit]
   Description=Quiz Live
   After=network.target

   [Service]
   WorkingDirectory=/opt/quiz
   ExecStart=/usr/bin/node server.js
   Environment=PORT=3000
   Environment=HOST=127.0.0.1
   Environment=PUBLIC_URL=https://quiz.mondomaine.fr
   Environment=ADMIN_PASSWORD=un-mot-de-passe-long
   Restart=always
   User=www-data

   [Install]
   WantedBy=multi-user.target
   ```
   puis `sudo systemctl enable --now quiz caddy` (`www-data` doit pouvoir écrire dans `/opt/quiz/data`).

En **mode hébergé** (dès que `PUBLIC_URL` est défini), la page de gestion exige **toujours** le mot de passe, même depuis le serveur lui-même : un serveur web mal configuré ne peut donc pas ouvrir la gestion à tout le monde. Sans `ADMIN_PASSWORD`, personne ne peut y accéder (un avertissement s'affiche au démarrage). `HOST=127.0.0.1` empêche de contourner le HTTPS en appelant directement `http://IP:3000`.

### Sécurité de la page de gestion

L'éditeur de quiz et la création de salon ne sont accessibles **que depuis le PC qui fait tourner le quiz** (`http://localhost:3000/host`). Depuis un autre appareil (même via le tunnel), l'accès est refusé, sauf si vous définissez un mot de passe (en mode hébergé, le mot de passe est toujours exigé) :

```
set ADMIN_PASSWORD=monMotDePasse && node server.js --internet
```

La page de gestion le demandera alors une fois. Les pages joueur et projection restent ouvertes à tous (elles ne permettent que de jouer / regarder).

## Types de questions

- **Choix multiple** : 2 à 6 réponses, une ou plusieurs marquées « bonne » (bouton raccourci Vrai/Faux). Réglage « Réponse du joueur » :
  - *Une seule réponse à toucher* (par défaut) : si plusieurs réponses sont bonnes, n'importe laquelle rapporte tous les points.
  - *Cocher toutes les bonnes réponses — tout ou rien* : le joueur coche plusieurs cases puis valide ; il marque seulement s'il a coché exactement toutes les bonnes et aucune mauvaise.
  - *Cocher toutes les bonnes réponses — points partiels* : points = (bonnes cochées − mauvaises cochées) ÷ nombre de bonnes, jamais négatif (1 bonne sur 2 = moitié des points).
  
  Dans ces deux modes, le joueur voit combien de réponses sont attendues.
- **Mot / nom** : liste de réponses acceptées séparées par `|`. Majuscules, accents, ponctuation et articles sont ignorés ; les fautes de frappe (1 à 2 lettres) sont tolérées si l'option est cochée. L'animateur peut accepter ou refuser une réponse en un clic pendant la partie.
- **Valeur à trouver** : valeur exacte + tolérance ±, unité facultative. Mode « le plus proche » (le ou les joueurs les plus proches marquent, en plus de ceux dans la tolérance) ou « tolérance uniquement ».
  Les joueurs répondent en **bougeant un curseur** (plus des boutons −/+ ; garder le doigt appuyé fait défiler). Le min et le max du curseur sont **calculés automatiquement** d'après la valeur, dans le bon ordre de grandeur (ex. 330 m → 100 à 1 100 m, une année → plage de 200 ans), sans jamais mettre la réponse au milieu, et avec un pas qui permet de tomber pile dessus. On peut aussi fixer « Curseur : min / max » dans l'éditeur, qui affiche toujours la plage que verront les joueurs (et prévient si la valeur est hors plage).
- **Carte (repère)** : le joueur pose un repère sur une carte (ex. « Où se trouve Lyon ? »). Dans l'éditeur, cliquez sur la carte pour placer le point à trouver, donnez la réponse affichée, le rayon qui donne tous les points (km) et, en mode **dégressif**, la distance à partir de laquelle on n'a plus aucun point ; ou mode « le plus proche ». Le bouton « 📌 Utiliser cette vue » règle la vue de départ des joueurs. Les joueurs voient une carte **sans nom de ville** (seulement pays et mers) ; à la révélation, l'écran montre le repère de chacun et sa distance.
  La carte (Leaflet + fond Esri) se charge depuis Internet : le PC et les téléphones doivent avoir accès à Internet.

Chaque question a ses **points** et son **temps** (0 = illimité ; avec un temps, le plus rapide gagne plus), et une image facultative (URL) affichée en projection. Le quiz de démonstration contient un exemple de chaque type, dont une question carte.

**🪤 Question piège** (case en bas de chaque question, tous types) : il n'y a aucune bonne réponse, seuls les joueurs qui **ne répondent pas** gagnent les points. Rien ne la distingue pour les joueurs ; à la révélation, l'écran annonce « C'était un piège ! » et le nombre de joueurs qui ont résisté. Pensez à mettre un temps limité, sinon il faut fermer la question à la main.

## Préparer les questions dans Excel

Ouvrez `Modele-Questions.xlsx` (dans ce dossier, ou bouton « 📊 Modèle Excel » de la page de gestion). Remplissez le titre en B1 puis une ligne par question ; l'onglet « Aide » explique chaque colonne. Ensuite, page de gestion → **Importer** → choisissez le fichier `.xlsx` : un nouveau quiz est créé, et les lignes à vérifier (bonne réponse manquante, nombre invalide…) sont signalées.

- Choix multiple : choix A à F, et la lettre de la bonne réponse (`B`, ou `A,C` pour plusieurs). Colonne « Plusieurs réponses » : `Non`, `Oui - tout ou rien` ou `Oui - points partiels`.
- Mot / nom : réponses acceptées séparées par `|`.
- Valeur à trouver : le nombre exact, plus tolérance, unité et mode facultatifs.
- Carte : type `Carte`, et dans « Bonne réponse » simplement le lieu, ex. `Lyon` : il est **placé automatiquement** à l'import (recherche OpenStreetMap, environ 1 s par lieu ; précisez le pays en cas de doute : `Valence, Espagne`). On peut aussi donner la position exacte : `Lyon (45.764, 4.8357)`. Tolérance en km, mode `Dégressif` ou `Le plus proche`. Vérifiez ensuite le point dans l'éditeur.
- Colonne « Piège » : `Oui` pour une question piège.

Dans l'autre sens, **Exporter Excel** télécharge le quiz affiché dans ce même format : on peut le modifier dans Excel puis le réimporter (il est ajouté comme nouveau quiz). **Exporter JSON** reste disponible pour une sauvegarde complète.

## Musique d'attente

L'écran de projection joue une petite musique d'attente pendant la salle d'attente, et l'arrête en fondu dès que le quiz démarre (elle revient si vous relancez une partie). C'est un morceau original généré par le navigateur : aucun fichier nécessaire.

- Bouton **🎵 Musique** en bas à droite de l'écran de projection pour la couper ou la remettre (le choix est mémorisé).
- Les navigateurs n'autorisent le son qu'après un clic : si un bandeau « Cliquez n'importe où pour activer la musique » apparaît, cliquez une fois sur l'écran (le bouton Plein écran suffit).
- **Votre propre musique** : déposez un fichier `musique-attente.mp3` (ou `.ogg`, `.m4a`, `.wav`) dans le dossier `public` ; il sera joué en boucle à la place. Utilisez une musique dont vous avez les droits de diffusion.

## Mode test (#dev)

Un joueur qui s'inscrit avec un pseudo terminé par `#dev` (ex. `Lucas#dev`) voit la bonne réponse sur son téléphone pendant chaque question. Partout ailleurs (projection, classements, autres joueurs), son nom s'affiche sans `#dev` et rien ne le distingue.

Pour repérer ces joueurs, lancez `Lancer-Quiz-Dev.bat` : c'est le mode Internet, mais la page de gestion s'ouvre en mode dev (`http://localhost:3000/host?dev=1`, badge « 🛠 dev » en haut). Seul ce mode affiche le badge « 🛠 test » à côté des joueurs `#dev`.

Pour désactiver le mode test :
- **Pour tout le salon** : décochez « Mode test (#dev) autorisé » dans les réglages de l'onglet Partie (disponible dans tous les modes). Plus aucun téléphone ne voit les réponses, immédiatement ; recochez pour le réautoriser.
- **Pour un seul joueur** (mode dev) : cliquez sur le ✕ de son badge « 🛠 test ». C'est définitif pour ce joueur.

## Tentation de triche

Case **🎲 Tentation de triche** dans les réglages de l'onglet Partie (désactivée par défaut). Entre deux questions (écran de réponse ou classement), certains joueurs reçoivent sur leur téléphone une proposition : tricher à la prochaine question. S'ils acceptent, la bonne réponse est envoyée automatiquement pour eux… mais chaque triche peut leur faire **tout perdre**.

- Ça n'arrive qu'à **peu de joueurs** : sur toute la partie, au plus 1 joueur sur 6 (au moins 1) reçoit une proposition, tiré au sort, un à la fois et seulement certaines manches. Un joueur qui refuse n'est plus sollicité ; un joueur qui a triché est redemandé **à chaque manche**.
- **Le premier du classement** (ou les premiers ex æquo) ne reçoit **jamais** de proposition.
- Pour la **fermeture automatique**, un tricheur compte comme ayant répondu (y compris sur une question piège).
- Risque de tout perdre, **pondéré par le nombre de questions** N : 2 % la 1re fois, puis +3/N à chaque triche (95 % au plus). Exemples : 10 questions → 2 %, 32 %, 62 %, 92 % ; 20 questions → 2 %, 17 %, 32 %, 47 %… Le téléphone affiche un niveau (minuscule, réel, élevé…).
- **L'animateur voit le risque** dans la liste des joueurs : badge `🎲2 · 47 %` = 2 triches, 47 % de risque à la prochaine ; `?` = proposition en cours, 😈 = va tricher à la prochaine question, 💀 = s'est déjà fait prendre ; la page de gestion affiche aussi l'étiquette rouge **Tricheur** à côté de son nom.
- **Pris la main dans le sac** : à la question où le tirage le démasque, le tricheur **perd tous ses points juste après cette question** (ceux de la question compris). Il continue ensuite à jouer et **regagne des points normalement** s'il ne triche plus, mais **chaque nouvelle triche le fait retomber à 0** (à coup sûr, il est déjà démasqué).
- **Personne ne le sait avant la fin** : pendant la partie, les téléphones (le sien compris) et l'écran de projection affichent son score comme s'il n'avait pas été pris. Seule la page de gestion montre son score réel et l'étiquette **Tricheur**.
- Au **classement final**, les remises à zéro s'appliquent : son vrai score apparaît, avec « Tricheur » en rouge à côté de son nom (téléphones et écran de projection).
- Décocher la case retire les propositions en cours et les triches pas encore jouées.

## Vol de points

Quand **un seul joueur** a bien répondu à une question, son téléphone lui propose de **voler un peu de points** à un joueur de son choix : 30 % du score de la victime, sans dépasser la moitié des points de la question. Un seul vol par question, possible jusqu'au lancement de la question suivante. L'écran de projection annonce « 🦹 Mia a volé 30 pts à Bob ! », la victime est prévenue sur son téléphone, et la page de gestion l'affiche. (Pas de vol sur les questions piège.) Le vol peut être désactivé à la création de la partie (case « 🦹 Vol de points ») ou en cours de partie dans la page de gestion : désactivé, un vol proposé mais pas encore fait est annulé.

## Pendant la partie

Démarrer → la question s'affiche (fermeture automatique à la fin du temps ou quand tout le monde a répondu ; un joueur exclu, ou dont le téléphone est déconnecté depuis plus de 6 secondes, n'est plus attendu, alors qu'une courte mise en veille ne fait pas passer à la réponse) → Révéler → Classement → Question suivante → … → podium final.

**⏱ Points selon la rapidité** (case cochée par défaut, à la création du salon et dans les réglages de la partie) : sur les questions avec un temps limité, le **premier** qui répond correctement (ou en partie) a tous les points, puis c'est dégressif selon son retard sur lui, jusqu'à 50 % à la fin du temps. Case décochée, ou question sans temps limité : toutes les bonnes réponses valent la même chose.

Options : +10 s, aller à n'importe quelle question, corriger une réponse à la main, ajuster un score de ±10, exclure un joueur, changer de quiz en gardant les joueurs, rejouer.

Les joueurs qui rechargent la page ou perdent le réseau sont reconnectés automatiquement avec leur score.

## Tournoi

Un tournoi enchaîne plusieurs **étapes** ; à la fin de chacune, les **N premières équipes** sont qualifiées pour la suivante. Une équipe = un téléphone (un seul membre de l'équipe se connecte).

**Créer un tournoi** : onglet **🏆 Tournois** → « + Nouveau », puis ajoutez et ordonnez les étapes. Le contenu de chaque étape vient de vos quiz (onglet Questions) :

| Étape | Contenu à préparer | Déroulement |
|---|---|---|
| 🎯 **Quiz** | un quiz | Un quiz classique sur les téléphones. |
| 🗂 **Thèmes** | **un quiz par thème** (le titre du quiz = le nom du thème), questions à choix multiple avec au moins 4 réponses dont une bonne | L'équipe dont c'est le tour joue sur son téléphone (ou à l'oral, l'animateur clique pour elle). Voir ci-dessous. |
| 🖼 **Images** | un **quiz d'images** (une question « Mot / nom » par image : l'adresse de l'image dans le champ Image, les noms acceptés comme réponses) + un quiz de **questions** | Voir ci-dessous. |

Réglages par étape : nombre de qualifiés ; pour Thèmes, le nombre de questions par équipe et les points Duo / Carré / Cash (25 / 50 / 100 par défaut) ; pour Images, le nombre d'images pour gagner (3), le nombre de bonnes réponses pour une image complètement nette (5) et l'effet : image floutée, ou toute petite (sa taille est multipliée par le même facteur à chaque bonne réponse, de 5 % à 100 % : elle reste petite au début et grandit surtout à la fin).

**Lancer** : onglet Partie → Type de partie « 🏆 Tournoi ». Chaque étape commence par un écran de présentation (« Lancer l'étape ») et se termine par le classement avec les qualifiés **pré-cochés** : cochez / décochez pour départager des ex æquo ou repêcher une équipe, puis « Étape suivante ». Les scores repartent de zéro à chaque étape. Les équipes éliminées voient « Tu as été éliminé » et suivent la suite à l'écran ; une équipe qui rejoint après le début du tournoi regarde seulement. La dernière étape donne le podium final.

**Étape Thèmes** : les équipes passent dans l'ordre du classement de l'étape précédente (la 1re choisit en premier). L'écran de projection montre la grille des thèmes ; un thème choisi est grisé. L'équipe dont c'est le tour choisit son thème sur son téléphone. Pour chaque question, l'énoncé s'affiche seul (projection et téléphones) ; l'équipe choisit **Duo** (2 réponses affichées : la bonne et une mauvaise tirée au hasard), **Carré** (4 réponses) ou **Cash** (aucune réponse), puis répond sur son téléphone : elle touche une réponse, ou en Cash tape la sienne (une petite faute de frappe est acceptée). Les réponses proposées s'affichent sur la projection et sur tous les téléphones ; les autres équipes suivent sans pouvoir jouer. L'équipe peut aussi tout annoncer à l'oral : vous cliquez alors son choix et sa réponse (en Cash : ✓ / ✗). Une fois la réponse donnée, seul l'animateur peut la corriger, tant qu'il n'est pas passé à la suite. Une question qui n'est pas à choix multiple ne peut se jouer qu'en Cash.

**Étape Images** : une seule image pour toutes les équipes. Des questions sont posées sur les téléphones (comme un quiz) ; **chaque bonne réponse rend l'image plus nette sur le téléphone de l'équipe**. L'écran de projection montre l'image avec la netteté **la plus basse** des équipes (elle ne devient plus nette que quand toutes les équipes ont progressé), ainsi que le nombre de bonnes réponses et d'images trouvées de chaque équipe. Après chaque question (« 🖼 Propositions d'image »), chaque équipe peut proposer un nom sur son téléphone (une proposition par question) : **la première proposition juste gagne l'image tout de suite**, sans clic de votre part. La page de gestion liste aussi les propositions, de la plus rapide à la plus lente ; « Attribuer » donne l'image à une proposition jugée fausse à tort. Une équipe qui trouve **à l'oral** reçoit l'image d'un clic sur son bouton (« Image trouvée à l'oral »), **à tout moment** de l'étape : pendant une question, après la réponse ou pendant les propositions, même si personne n'a rien envoyé. Seule l'équipe la plus rapide gagne l'image ; on passe alors à l'image suivante (netteté remise à zéro). La première équipe à atteindre l'objectif gagne. « Personne ne trouve : dévoiler » passe l'image sans l'attribuer ; « Annuler l'attribution » corrige une erreur. Si toutes les questions ont été posées, elles recommencent au début.

Les images passent par le serveur : les téléphones ne voient pas l'adresse d'origine (souvent parlante, comme `tour-eiffel.jpg`). Une image peut être une adresse Internet ou un fichier déposé dans `public` (ex. `/images/tour.jpg`).

## Pages de test

Le dossier `public/tests/` regroupe des pages pour vérifier une fonctionnalité sans lancer de partie. Elles ne sont reliées à aucune page de l'appli et n'ont pas besoin du serveur : ouvrez simplement le fichier dans votre navigateur (double-clic). Elles marchent aussi avec le serveur lancé, à l'adresse /tests/….

| Page | Ce qu'elle montre |
|---|---|
| `public/tests/flou.html` | Étape Images : l'image floutée ou toute petite à chaque niveau de netteté, sur la projection et sur le téléphone, avec le même calcul que le jeu. Une image peut venir d'une adresse internet ou d'un fichier de l'ordinateur. |

## Données

Les quiz sont enregistrés dans `data/quizzes.json` et les tournois dans `data/tournaments.json` (sauvegarde automatique pendant l'édition, avec une copie de secours `.bak`). Export/import JSON depuis l'éditeur. Les parties en cours sont en mémoire : redémarrer le serveur les termine.
