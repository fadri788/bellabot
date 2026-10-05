# BellaBot – Übersicht

## Funktionsweise

Der BellaBot scannt den Raum mit **Laser und Kameras** und erstellt daraus eine Karte. Damit findet er selbstständig zu den Tischen. **Sensoren** lassen ihn Hindernissen ausweichen und schützen ihn davor, Treppen hinunterzufallen. Das Personal wählt am **Display** den Tisch aus, und wenn der Akku schwach ist, fährt er von selbst zur **Ladestation**.

## Zustände

| Zustand | Beschreibung |
|---|---|
| **Idle / Standby** | Wartet am Abholpunkt auf einen Auftrag. |
| **Charging** | Steht an der Ladestation oder hängt am Kabel. |
| **Returning** | Fährt nach einem Auftrag zurück. |
| **Paused** | Wurde angetippt oder ist blockiert und wartet. |
| **Sleep** | Spart Strom, wenn er länger nichts tut. |
| **Emergency Stop** | Der rote Notaus-Knopf ist gedrückt, die Motoren sind aus. |

## Karte

Die Karte zeigt die Fahrwege des BellaBots aus der Vogelperspektive. Die grauen Linien sind die Routen, auf denen er sich bewegen darf, nicht die Wände des Raums.

Der Bereich ist ungefähr rechteckig und leicht schräg. Eine Linie in der Mitte teilt ihn in zwei Zonen, sodass der Roboter auch quer abkürzen kann. Kurze Abzweigungen links und oben führen vermutlich zu Tischen oder Haltepunkten. Unten rechts gibt es eine kleine Schlaufe mit einem Ausläufer, wahrscheinlich der Bereich der Ladestation oder des Abholpunkts.

Unter der Karte kann man den **Startpunkt** auswählen, von dem aus der Roboter seine Fahrt beginnt.