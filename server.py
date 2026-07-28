import subprocess
import json
import requests
import urllib3
import os
import sys

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
sys.stdout.reconfigure(encoding='utf-8')

from flask import Flask, jsonify, request, send_from_directory

app = Flask(__name__, static_folder='.')

@app.after_request
def after_request(response):
    response.headers.add('Access-Control-Allow-Origin', '*')
    response.headers.add('Access-Control-Allow-Headers', 'Content-Type,Authorization')
    response.headers.add('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE,OPTIONS')
    return response

BASE_CC_URL = "https://www.cinema-city.co.il"
HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/javascript, */*; q=0.01',
    'X-Requested-With': 'XMLHttpRequest'
}

THEATERS = [
    {"id": 1, "tixId": 1170, "name": "סינמה סיטי גלילות"},
    {"id": 2, "tixId": 1173, "name": "סינמה סיטי ראשון לציון"},
    {"id": 3, "tixId": 1174, "name": "סינמה סיטי ירושלים"},
    {"id": 4, "tixId": 1175, "name": "סינמה סיטי כפר סבא"},
    {"id": 5, "tixId": 1176, "name": "סינמה סיטי נתניה"},
    {"id": 6, "tixId": 1178, "name": "סינמה סיטי באר שבע"},
    {"id": 7, "tixId": 1179, "name": "סינמה סיטי חדרה"},
    {"id": 8, "tixId": 1180, "name": "סינמה סיטי אשדוד"}
]

SHOW_SEATS_CACHE = {}

@app.route('/')
def index():
    return send_from_directory('.', 'index.html')

@app.route('/api/theaters')
def get_theaters():
    return jsonify(THEATERS)

@app.route('/api/movies')
def get_movies():
    theater_id = request.args.get('theaterId', '1170')
    try:
        r = requests.get(f"{BASE_CC_URL}/tickets/Movies", headers=HEADERS, verify=False, timeout=10)
        return jsonify(r.json())
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/dates')
def get_dates():
    theater_id = str(request.args.get('theaterId', '1170'))
    movie_id = str(request.args.get('movieId', '6123'))
    tix_map = {"1": "1170", "2": "1173", "3": "1174", "4": "1175", "5": "1176", "6": "1178", "7": "1179", "8": "1180"}
    real_tix = tix_map.get(theater_id, theater_id)

    try:
        r = requests.get(f"{BASE_CC_URL}/tickets/Events", params={
            "MovieId": movie_id,
            "TheatreId": real_tix,
        }, headers=HEADERS, verify=False, timeout=10)
        
        data = r.json()
        unique_days = []
        seen = set()

        if isinstance(data, list) and len(data) > 0 and 'Dates' in data[0]:
            for d in data[0]['Dates']:
                day_str = d.get('Day', '')
                if day_str and day_str not in seen:
                    seen.add(day_str)
                    unique_days.append(day_str)
        
        if len(unique_days) > 0:
            return jsonify(unique_days)

        # Fallback to GetDatesByTheaterMovieVenueType
        r_fallback = requests.get(f"{BASE_CC_URL}/tickets/GetDatesByTheaterMovieVenueType", params={
            "theaterId": theater_id,
            "movieId": movie_id,
            "venueTypeId": 0
        }, headers=HEADERS, verify=False, timeout=10)
        return jsonify(r_fallback.json())

    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/batch_date_seats')
def get_batch_date_seats():
    theater_id = request.args.get('theaterId', '1170')
    movie_id = request.args.get('movieId', '6123')
    date_str = request.args.get('date', '')

    try:
        cmd = ["node", "fetch_batch_seats.js", str(theater_id), str(movie_id), str(date_str)]
        res = subprocess.run(cmd, capture_output=True, text=True, cwd=os.getcwd(), encoding='utf-8')
        if res.returncode == 0:
            out_json = json.loads(res.stdout)
            showtimes = out_json.get('showtimes', [])
            
            for s in showtimes:
                if s.get('eventId') and (s.get('seatplan') or s.get('seatsStatus')):
                    SHOW_SEATS_CACHE[str(s['eventId'])] = s

            return jsonify(out_json)
        else:
            return jsonify({"error": res.stderr, "showtimes": []}), 500
    except Exception as e:
        return jsonify({"error": str(e), "showtimes": []}), 500

@app.route('/api/show_seats')
def get_show_seats():
    event_id = str(request.args.get('eventId', ''))
    
    if event_id in SHOW_SEATS_CACHE:
        return jsonify(SHOW_SEATS_CACHE[event_id])

    try:
        # Direct session presentation fetch in Python
        r = requests.get(f"https://tickets.cinema-city.co.il/api/presentations/{event_id}", headers=HEADERS, verify=False, timeout=10)
        if r.status_code == 200:
            pres = r.json().get('presentation', {})
            if pres:
                v_id = pres.get('venueId')
                sp_id = pres.get('seatplanId')
                vt_id = pres.get('venueTypeId')
                is_res = 1 if pres.get('isReserved') else 0

                sp_res = requests.post(f"https://tickets.cinema-city.co.il/api/seats/seatplanV2?venueId={v_id}&seatplanId={sp_id}", headers=HEADERS, verify=False, timeout=10)
                st_res = requests.get(f"https://tickets.cinema-city.co.il/api/seats/seats-statusV2?presentationId={event_id}&venueTypeId={vt_id}&isReserved={is_res}", headers=HEADERS, verify=False, timeout=10)

                sp_json = sp_res.json() if sp_res.status_code == 200 else {}
                st_json = st_res.json() if st_res.status_code == 200 else {}

                seatplan_data = sp_json.get('S') if sp_json.get('S') else sp_json

                out = {
                    "eventId": event_id,
                    "featureName": pres.get('featureName', ''),
                    "featureImageUrl": pres.get('featureImageUrl', ''),
                    "venueName": pres.get('venueName', 'אולם'),
                    "seatplan": seatplan_data,
                    "seatsStatus": st_json.get('seats', {})
                }
                SHOW_SEATS_CACHE[event_id] = out
                return jsonify(out)

        return jsonify({"error": "Failed to fetch presentation"}), 500
    except Exception as e:
        return jsonify({"error": str(e)}), 500

if __name__ == '__main__':
    print("Starting Cinema City Seats Server on http://localhost:5000")
    app.run(host='0.0.0.0', port=5000, debug=False)
