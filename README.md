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

## Datenpunkte

| Datenpunkt | Inhalt |
|---|---|
| `power.pv`, `power.grid` (+ Bezug / − Einspeisung), `power.import`, `power.export`, `power.house` | Leistung jetzt (W) |
| `power.battery` (+ laden / − entladen), `power.soc` | Batterie |
| `today.*`, `yesterday.*` | pv, house, import, export, charge, discharge (kWh), autarky, selfUse (%) |
| `consumers.<name>.power`, `.today` | je Verbraucher |
| `surplus.power`, `surplus.active` | Überschuss (Einspeisung, optional + Batterieladung) und Signal mit Schwellen/Verzögerung – z. B. für ioBroker.logik |
| `live` | alle Werte als JSON (für SmartView) |

Die Tageswerte rechnet der Adapter selbst aus den Leistungen (alle 2 Sekunden); dafür braucht es keine
Zähler-Datenpunkte. Der Tagesverlauf (5-Minuten-Werte, 8 Tage) und die Tagessummen (400 Tage) liegen im
Datenverzeichnis der Instanz – kein History-Adapter nötig.

## Changelog

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
