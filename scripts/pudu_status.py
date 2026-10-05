"""
Pudu Cloud API: Status eines Roboters abfragen (Beispiel)

Vorher Umgebungsvariablen setzen (PowerShell):
    $env:PUDU_API_APP_KEY = "dein-key"
    $env:PUDU_API_APP_SECRET = "dein-secret"

Installieren:  pip install requests
Starten:       python pudu_status.py SERIENNUMMER
"""

import base64
import datetime
import hashlib
import hmac
import os
import sys

import requests

HOST = "csg-open-platform.pudutech.com"  # Cluster "de" (Deutschland)
PATH = "/pudu-entry/open-platform-service/v2/status/get_by_sn"


def get_status(sn: str) -> dict:
    app_key = os.environ["PUDU_API_APP_KEY"]
    app_secret = os.environ["PUDU_API_APP_SECRET"]

    query = f"sn={sn}"
    date = datetime.datetime.now(datetime.timezone.utc).strftime("%a, %d %b %Y %H:%M:%S GMT")

    # 1. Text bauen, der signiert wird (bei GET ist Content-MD5 leer)
    signing_str = f"x-date: {date}\nGET\napplication/json\napplication/json\n\n{PATH}?{query}"

    # 2. Mit dem Secret per HMAC-SHA1 signieren und Base64-codieren
    signature = base64.b64encode(
        hmac.new(app_secret.encode(), signing_str.encode(), hashlib.sha1).digest()
    ).decode()

    # 3. Header zusammenbauen (das Secret selbst wird nie mitgeschickt)
    headers = {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "x-date": date,
        "Authorization": f'hmac id="{app_key}", algorithm="hmac-sha1", '
                         f'headers="x-date", signature="{signature}"',
    }

    response = requests.get(f"https://{HOST}{PATH}?{query}", headers=headers, timeout=15)
    response.raise_for_status()
    return response.json()


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Bitte Seriennummer angeben: python pudu_status.py SERIENNUMMER")
        sys.exit(1)

    result = get_status(sys.argv[1])

    if result.get("message") == "SUCCESS":
        data = result["data"]
        print(f"Status: {data.get('runState')}")
        print(f"Akku:   {data.get('battery')} %")
        print(f"Lädt:   {'ja' if data.get('isCharging') else 'nein'}")
    else:
        print("Fehler:", result)