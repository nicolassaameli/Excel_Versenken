# Zellen versenken

Schiffe versenken im Look einer Tabellenkalkulation. Zwei Spieler treten online gegeneinander an.
Das Spiel ist eine statische Webseite (GitHub Pages), Supabase dient als Live-Datenbank.

## Projektstruktur

| Datei | Inhalt |
|---|---|
| `index.html` | Gerüst: Titelleiste, Menüband, Bearbeitungsleiste, Blatt, Statusleiste, Backstage |
| `css/excel.css` | Gesamtes Styling |
| `js/config.js` | **Supabase-URL und anon-Key eintragen** |
| `js/core.js` | Flotte, Koordinaten, Platzierungsregeln |
| `js/formulas.js` | Formel-Parser: Funktionsliste, Schreibweise prüfen, Fehlermeldungen (#NAME?, #BEZUG!, #WERT!) |
| `js/backends.js` | `OnlineBackend` (Supabase) und `LocalBackend` (gegen den Computer) |
| `js/app.js` | Benutzeroberfläche und Spielablauf |
| `supabase/schema.sql` | Tabellen, Sicherheitsregeln und Spielfunktionen |

## Einrichtung

### 1. Supabase
1. Auf [supabase.com](https://supabase.com) ein Projekt anlegen.
2. Im Dashboard **SQL Editor** öffnen, den Inhalt von `supabase/schema.sql` einfügen und ausführen.
3. Unter **Project Settings → API** die *Project URL* und den *anon public* Key kopieren.
4. Beides in `js/config.js` eintragen.

Bei einer Aktualisierung genügt es, `schema.sql` erneut auszuführen (fehlende Spalten werden ergänzt).

Der anon-Key darf öffentlich im Repo stehen. Geschützt wird das Spiel durch die Datenbank:
Schiffspositionen und Spieler-Tokens sind nicht direkt lesbar. Alle Spielzüge laufen über
Funktionen (`create_game`, `join_game`, `submit_ships`, `fire`, `scan`, `resign`, `get_state`), die den
geheimen Token jedes Spielers prüfen. So lassen sich die gegnerischen Schiffe nicht über die
Browser-Konsole auslesen, und auch Züge außer der Reihe sind nicht möglich.

### 2. GitHub Pages
1. Repository auf GitHub pushen.
2. **Settings → Pages → Branch: `main` / root** wählen.
3. Die Seite ist danach unter `https://<benutzer>.github.io/<repo>/` erreichbar.

### Lokal testen
Einen beliebigen statischen Server im Projektordner starten, z. B.:
```
python -m http.server 8000
```
Dann `http://localhost:8000` öffnen. Der Modus „Gegen den Computer“ funktioniert auch ohne Supabase.

## Spielregeln
- 10×10-Feld, Flotte: Flugzeugträger (5), Schlachtschiff (4), Kreuzer (3), U-Boot (3), Zerstörer (2).
- Schiffe dürfen sich berühren, aber nicht überlappen.
- Wer beginnt, entscheidet der Zufall. **Ein Treffer gibt einen weiteren Schuss.**
- Statt zu schiessen, kann man mit `=SUCHEN()` 2×2 Zellen absuchen. Das kostet den Zug, und das Ergebnis
  ist nur 2,5 Sekunden sichtbar. Wer es sich merken will, markiert die Zellen mit einer Füllfarbe.
- Wer zuerst alle gegnerischen Schiffe versenkt, gewinnt.

## Bedienung – alles über Formeln
Das Spiel trainiert das korrekte Schreiben von Funktionen. Die Formeln verwenden die echten Zellbezüge des Blatts:
Das eigene Feld ist **C6:L15**, das gegnerische Feld **O6:X15**.

| Formel | Wirkung |
|---|---|
| `=FLUGZEUGTRÄGER(C6:G6)` | Platziert den Flugzeugträger (5 Zellen). Ebenso `=SCHLACHTSCHIFF(…)` (4), `=KREUZER(…)` (3), `=UBOOT(…)` (3), `=ZERSTÖRER(…)` (2) |
| `=BEREIT()` | Gibt die Flotte ab |
| `=LEEREN()` | Entfernt alle Schiffe |
| `=FEUER(Q8)` | Schiesst auf eine Zelle im gegnerischen Feld |
| `=SUCHEN(Q8:R9)` | Zeigt kurz, wo in 2×2 Zellen Schiffe liegen (kostet den Zug) |
| `=HILFE()` | Öffnet das Blatt «Hilfe» |

- Falsch geschriebene Formeln erzeugen Excel-typische Fehler mit Erklärung und Korrekturvorschlag,
  z. B. `#NAME?` bei `=FLUGZEUGTRAGER(…)`, `#BEZUG!` bei `=FEUER(8Q)` oder `=KREUZER(C6-E6)`, `#WERT!` bei falscher Länge.
- Hilfen wie in Excel: Autovervollständigung (Tab), Argument-Tipp, Live-Vorschau im Spielfeld, Zeigemodus
  (während des Tippens Zelle anklicken oder Bereich aufziehen fügt den Bezug ein).
- Für `FEUER` und `SUCHEN` gibt es bewusst keine Knöpfe. Die Schiffs- und `BEREIT`-Knöpfe im Menüband sowie 𝑓x schreiben nur die Vorlage in die Bearbeitungsleiste, ausführen muss man selbst.
- **Start → Füllfarbe** bzw. **Zellenformatvorlagen** färben die ausgewählten Zellen (Bereiche per Ziehen oder Shift).
  Die Formatierung wird pro Spiel im Browser gespeichert.
- Die Statusleiste zählt korrekte und fehlerhafte Formeln.
- **Datei → Neu**: Online-Spiel erstellen oder gegen den Computer spielen. **Datei → Öffnen**: mit Code beitreten.
- **Start → Einladen**: Code oder Link (`?spiel=CODE`) teilen.

## Aufräumen (optional)
Am Ende von `schema.sql` steht ein auskommentierter `pg_cron`-Job, der alte Spiele löscht.

---
Kein Microsoft-Produkt, nur ein Schulprojekt zum Spass.
