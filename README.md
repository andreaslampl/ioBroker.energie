# ioBroker.energie

![Logo](admin/energie.png)

Energiefluss für ioBroker – einfacher als der energiefluss-Adapter und für **jeden Wechselrichter**:
PV, Netz, Batterie, Haus und Verbraucher als animiertes Bild, dazu Tageswerte (Autarkie, Eigenverbrauch …),
Tageskurve und ein Überschuss-Signal. Anzeige in **SmartView** (Kachel „Energiefluss“) und in **VIS‑2**.

## Installation

```
iobroker url https://github.com/andreaslampl/ioBroker.energie
```

Danach eine Instanz anlegen und in den Einstellungen die Datenpunkte wählen.

## Einrichten

Die Werte können aus **jedem Adapter** kommen (Modbus, SMA, Fronius, Huawei, Kostal, E3DC, Shelly 3EM, KNX, …).

| Reiter | Was |
|---|---|
| **PV & Netz** | PV: Datenpunkt der PV-Leistung; weitere Wechselrichter/Strings in der Tabelle darunter (Zeile mit **+** hinzufügen). Netz: ein Datenpunkt mit Vorzeichen (und was „positiv“ bedeutet) oder Bezug und Einspeisung getrennt. |
| **Batterie & Haus** | Batterie-Leistung (+ was „positiv“ bedeutet) und Ladestand – optional. Hausverbrauch optional: leer = der Adapter rechnet ihn aus. |
| **Verbraucher** | Bis zu 8, z. B. Wallbox, Wärmepumpe, Heizstab – mit Symbol. Sie hängen unter dem Haus. |
| **Überschuss** | Ein-/Ausschaltschwelle und Verzögerung für `surplus.active`. |
| **Darstellung** | Symbole rund oder eckig; Linien als laufende Punkte, laufende Striche oder durchgehend pulsierend; Animation immer an (Standard), wie am Gerät eingestellt oder aus; eigenes Symbol für PV, Netz, Batterie und Haus (z. B. Solarmodul, Zähler, Dach mit PV). |
| **Seite** | Port (Standard 8101), Zugriffsschlüssel. |

### Modbus & Co.: Werte richtig hinbekommen

Pro Datenpunkt gibt es:

- **Einheit** – automatisch (W oder kW aus dem Objekt), oder fest W / kW
- **Faktor** – z. B. `0.1` wenn das Register 10-mal zu groß ist, `10` wenn zu klein
- **Vorzeichen** – *vorzeichenbehaftet 16/32 Bit*, wenn negative Werte als 65535 … ankommen
- **umgekehrt** – aus negativ wird positiv (bei jedem Datenpunkt: PV, Netz, Batterie, Haus, Verbraucher)

Zum Ausprobieren gibt es die Seite **`/check`** („Werte prüfen“): Rohwert, Einstellung und Ergebnis jedes
Datenpunkts, aktualisiert alle 2 Sekunden. Einstellung ändern, speichern, schauen.

## Anzeigen

- **Seite:** `http://<ioBroker>:8101/flow` (steht auch in `energie.0.info.url`)
- **VIS‑2:** HTML-Widget mit
  `<iframe src="http://<ioBroker>:8101/flow?view=flow&bg=transparent" style="border:0;width:100%;height:100%"></iframe>`
  - `view=flow` nur der Fluss, `view=stats` nur die Tageswerte, `view=chart` nur die Kurve (ohne = alles)
  - `theme=dark` / `theme=light` (ohne = wie das Gerät), `bg=transparent` ohne Hintergrund
  - mit Zugriffsschlüssel zusätzlich `&key=…`
- **SmartView:** Kachel-Art „Energiefluss“ (ab SmartView 0.14.0) – Instanz wählen, fertig

### Symbole frei anordnen

Auf der Seite `http://<ioBroker>:8101/flow` oben rechts **„Anordnen“** tippen, dann PV, Netz, Batterie, Haus
und Verbraucher mit Maus oder Finger an die gewünschte Stelle ziehen und **„Speichern“**. „Zurücksetzen“ stellt
die Standard-Anordnung wieder her. Die Anordnung gilt überall: auf der Seite, in VIS‑2 und in SmartView.

## Wallbox – PV-Überschussladen

Im Reiter **Wallbox** die Datenpunkte der Wallbox eintragen. Für die **Siemens VersiCharge** (Adapter
[versicharge](https://github.com/andreaslampl/ioBroker.versicharge)):

| Feld | Datenpunkt |
|---|---|
| Ladeleistung | `versicharge.0.power.total` |
| Ladestrom (wird geschrieben) | `versicharge.0.control.current` |
| Auto angesteckt | `versicharge.0.status.plugged` |

Andere Wallboxen gehen genauso, wenn sie einen Datenpunkt für den Ladestrom in A haben (bei Bedarf
zusätzlich „Laden ein/aus“).

Den Modus schaltet `energie.0.wallbox.mode` um (SmartView-Kachel „Wallbox“, VIS, Skripte; Text oder Kürzel):

| Modus | Verhalten |
|---|---|
| **PV** (`pv`) | nur Überschuss: startet, wenn mindestens Mindeststrom × Phasen × 230 V übrig ist (3-phasig 6 A ≈ 4,1 kW), folgt der Sonne, pausiert nach der Verzögerung ohne Überschuss |
| **Min+PV** (`minpv`) | immer mindestens Mindeststrom, mehr bei Sonne |
| **Schnell** (`fast`) | höchster Strom |
| **Aus** (`off`) | 0 A = Pause |
| **Manuell** (`manual`) | energie schreibt nichts (z. B. Laden über die App) |

Verfügbar fürs Auto = Einspeisung + was das Auto schon lädt − Entladung des Hausakkus. Lädt der Hausakku,
zählt seine Ladeleistung fürs Auto mit – außer unter „Hausakku zuerst bis (%)“. Der Strom ändert sich höchstens
alle 10 Sekunden. `wallbox.status` zeigt, was die Regelung gerade macht (z. B. „Startet in 0:40“,
„PV-Laden 8 A“, „Zu wenig Überschuss – stoppt in 4:10“). Die Wallbox erscheint im Energiefluss als Verbraucher.

### Wallbox vor dem Zähler des Wechselrichters

Hängt die Wallbox **vor** dem Zähler des Wechselrichters (dann entlädt das Auto den Hausakku nicht), sieht dieser Zähler
das Laden nicht. Haken **„Wallbox hängt vor dem Zähler des Wechselrichters“** setzen: energie rechnet die Ladeleistung
dann zum Netzbezug und zum Hausverbrauch dazu (Energiefluss, Tageswerte, Regelung).

### Wärmepumpe und Lastspitzen (Netztarif nach Spitzenleistung)

Zwei Teile, jeder mit eigenem Haken (aus = Felder ausgeblendet, Regel aus):

- **Wärmepumpe hat Vorrang vor dem Auto:** Datenpunkt der Wärmepumpe mit der Art **Ein/Aus** (true/false),
  **Leistung** (läuft ab x W) oder **Status** (aus bei bestimmten Werten, Zahlen oder Texte – z. B. Ochsner
  „Wärmeerzeuger Status“ `0;3;8` = Standby, extern gesperrt, Störung). **Wenn die Wärmepumpe läuft:** **Auto pausieren**
  (kein Laden), **Auto nur mit Mindeststrom (6 A)** oder **Auto bekommt den Rest bis zur Grenze** (lädt weiter mit dem,
  was bis zur Netzbezugs-Grenze übrig bleibt – nur wählbar, wenn „Netzbezug begrenzen“ angehakt ist; wird die Grenze
  später ausgeschaltet, lädt das Auto bei laufender Wärmepumpe mit Mindeststrom) – in allen Modi.
- **Netzbezug begrenzen (Leistungstarif):** **Höchstens x kW, Haus + Auto zusammen.** Das Auto bekommt nur, was bis zu
  dieser Grenze **minus Reserve** (Standard 500 W) übrig ist, auf ganze Ampere abgerundet. Steigt der Hausverbrauch,
  wird der Ladestrom **sofort** gesenkt (erhöht wird höchstens alle 10 s); das Auto braucht dann noch einige Sekunden,
  bis es folgt. Reicht es nicht für den Mindeststrom, pausiert es und startet erst nach der Start-Verzögerung wieder.
  Beispiel: 12 kW, Reserve 0,5 kW, Haus mit Wärmepumpe 4 kW → fürs Auto 7,5 kW → 10 A (6,9 kW, 3-phasig).
  Tipp: Soll sich das Auto an die Grenze **anpassen** statt bei laufender Wärmepumpe ganz zu pausieren, den Haken
  „Wärmepumpe hat Vorrang“ ausschalten und nur die Grenze verwenden – die Wärmepumpe zählt ja zum Hausverbrauch.
- **Im Betrieb umschalten** (z. B. Schalter-Kachel in SmartView, VIS, Skript): `energie.0.wallbox.hpPriority`
  (true/false) und `energie.0.wallbox.peakLimit` (kW, 0 = aus). Bei jedem Start gelten wieder die Instanz-Einstellungen.
- **Fertig bis (optional):** Akkustand des Autos (z. B. aus dem VW-Adapter; mit **Faktor**, falls der Wert z. B. in
  Zehntel-Prozent kommt – `wallbox.carSoc` zeigt das Ergebnis zum Vergleich mit der App), Akkugröße, Ziel-% und Uhrzeit. Reicht die
  Zeit bis dahin mit Mindeststrom gerade noch (plus 15 Minuten Reserve), laden **beide** – das Auto mit Mindeststrom –,
  auch wenn die Wärmepumpe läuft oder die Grenze erreicht ist. `wallbox.urgent` zeigt das an.

Beispiel ID.4 (77 kWh), Ziel 80 %, fertig um 07:00, Akku 20 %: es fehlen ca. 46 kWh; mit 6 A × 3 Phasen (≈ 3,7 kW
im Auto) sind das ca. 12½ Stunden – ab ca. 18:20 lädt das Auto dann trotz Wärmepumpe mit Mindeststrom.

### Darstellung: Herkunft, Geschwindigkeit, Farbe des Hauses

- **Linie von:** Bei jedem Verbraucher (Reiter „Verbraucher“) und bei der Wallbox lässt sich wählen, woher seine Linie
  kommt – vom Haus (Standard), von PV, vom Netz, von der Batterie oder **von einem anderen Verbraucher** (dessen Namen
  in der Spalte daneben eintragen, z. B. eine Pumpe hinter einem Unterzähler). Das ist nur die Darstellung (z. B. ein Heizstab,
  der direkt am PV-Wechselrichter hängt); gerechnet wird wie bisher. Diese Linien laufen im Bogen am Haus vorbei.
- **Geschwindigkeit der Animation** (Reiter „Darstellung“): sehr langsam … sehr schnell; bei mehr Leistung bleibt es
  schneller.
- **Haus nach Herkunft einfärben:** grün = alles von PV/Batterie, orange = wenig aus dem Netz (bis zur eingestellten
  Grenze, Standard 1000 W), rot = mehr aus dem Netz.

## Datenpunkte

| Datenpunkt | Inhalt |
|---|---|
| `power.pv`, `power.grid` (+ Bezug / − Einspeisung), `power.import`, `power.export`, `power.house` | Leistung jetzt (W) |
| `power.battery` (+ laden / − entladen), `power.soc` | Batterie |
| `today.*`, `yesterday.*` | pv, house, import, export, charge, discharge (kWh), autarky, selfUse (%) |
| `consumers.<name>.power`, `.today` | je Verbraucher |
| `surplus.power`, `surplus.active` | Überschuss (Einspeisung, optional + Batterieladung) und Signal mit Schwellen/Verzögerung – z. B. für ioBroker.logik |
| `wallbox.hpPriority`, `wallbox.peakLimit` (schreibbar) | Wärmepumpen-Vorrang ein/aus, Bezugsgrenze in kW (0 = aus) |
| `wallbox.mode` (schreibbar), `wallbox.status`, `wallbox.target`, `wallbox.available`, `wallbox.urgent` | Wallbox: Modus, was die Regelung macht, vorgegebener Strom (A), verfügbare Leistung (W), „würde nicht rechtzeitig voll“ |
| `live` | alle Werte als JSON (für SmartView) |

Die Tageswerte rechnet der Adapter selbst aus den Leistungen (alle 2 Sekunden); dafür braucht es keine
Zähler-Datenpunkte. Der Tagesverlauf (5-Minuten-Werte, 8 Tage) und die Tagessummen (400 Tage) liegen im
Datenverzeichnis der Instanz – kein History-Adapter nötig.

## Changelog

### 0.7.2
- „Rest bis zur Grenze“ nur mit aktiver Bezugsgrenze wählbar; ohne Grenze Mindeststrom statt unbegrenzt.

### 0.7.1
- Wallbox: „Auto bekommt den Rest bis zur Grenze“, solange die Wärmepumpe läuft; Hilfetext zu den Möglichkeiten.

### 0.7.0
- Wallbox: klarere Bezeichnungen; Wärmepumpen-Vorrang und Bezugsgrenze mit eigenem Haken und im Betrieb umschaltbar
  (`wallbox.hpPriority`, `wallbox.peakLimit`).

### 0.6.2
- Linie eines Verbrauchers auch von einem anderen Verbraucher.

### 0.6.1
- Wallbox: Reserve unter der Bezugsgrenze (Standard 500 W); Ladestrom wird sofort gesenkt.

### 0.6.0
- Verbraucher (und Wallbox): Linie vom Haus, von PV, vom Netz oder von der Batterie (nur Darstellung).
- Geschwindigkeit der Animation einstellbar (sehr langsam … sehr schnell).
- Haus nach Herkunft einfärben: grün = nur PV/Batterie, orange = wenig aus dem Netz, rot = mehr.

### 0.5.2
- Faktor für den Akkustand des Autos, Ergebnis in `wallbox.carSoc`.

### 0.5.1
- Wärmepumpe auch als Status-Datenpunkt (aus bei bestimmten Werten, z. B. Ochsner Standby).

### 0.5.0
- Wallbox: Wärmepumpe hat Vorrang (Pause oder Mindeststrom), Grenze für den Netzbezug inkl. Auto, „Fertig bis“ mit dem Akkustand des Autos.
- Wallbox vor dem Zähler des Wechselrichters wird zu Netzbezug und Hausverbrauch gerechnet.

### 0.4.0
- Wallbox: PV-Überschussladen mit den Modi PV, Min+PV, Schnell, Aus, Manuell (z. B. Siemens VersiCharge über den Adapter versicharge).

### 0.3.0
- „Anordnen“: Symbole im Energiefluss frei platzieren (gilt auch für VIS‑2 und SmartView).

### 0.2.3
- Lange Verbraucher-Namen werden nicht mehr abgeschnitten.

### 0.2.2
- Behoben: Animation zu den Verbrauchern lief in die falsche Richtung (zum Haus).

### 0.2.1
- „umgekehrt“ bei jedem Datenpunkt (jetzt auch Netz, Batterie, Haus).

### 0.2.0
- Darstellung: rund/eckig, Punkte/Striche/durchgehend, Animation immer/wie Gerät/aus, Symbole wählbar; mehr Symbole für Verbraucher.

### 0.1.1
- Einstellungen: eigenes Feld für die PV-Leistung; die Tabelle ist für weitere Wechselrichter/Strings.

### 0.1.0
- Erste Version: Energiefluss, Tageswerte, Tageskurve, Überschuss-Signal, Seite für VIS‑2, Werte prüfen.

## Lizenz

MIT
