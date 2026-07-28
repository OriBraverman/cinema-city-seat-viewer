/**
 * Cinema City Realtime Batch Seat Fetcher
 * Establishes a single browser session to bypass Cloudflare/session validation,
 * captures session UUID header, then fetches full seat maps & availability in parallel
 * for all daily showtimes, pre-calculating free/occupied counts.
 */

const puppeteer = require('puppeteer-core');
const https = require('https');
const fs = require('fs');

const theaterId = process.argv[2] || '1170';
const movieId = process.argv[3] || '6123';
const dateInput = process.argv[4] || '30/07/2026';

const THEATER_TIX_MAP = {
  "1": "1170", "2": "1173", "3": "1174", "4": "1175",
  "5": "1176", "6": "1178", "7": "1179", "8": "1180"
};

const tixId = THEATER_TIX_MAP[theaterId] || theaterId;
const dateMatch = dateInput.match(/\d{2}\/\d{2}/);
const dateClean = dateMatch ? dateMatch[0] : '30/07';

function getChromeExecutablePath() {
  const paths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser'
  ];
  for (const p of paths) {
    if (p && fs.existsSync(p)) return p;
  }
  return 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
}

function httpGetJson(url) {
  return new Promise((resolve) => {
    const req = https.get(url, { rejectUnauthorized: false }, (res) => {
      res.setEncoding('utf8');
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch(e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
  });
}

(async () => {
  let browser;
  try {
    const eventsUrl = `https://www.cinema-city.co.il/tickets/Events?MovieId=${movieId}&TheatreId=${tixId}`;
    const eventsData = await httpGetJson(eventsUrl);

    let showtimes = [];
    if (eventsData && eventsData[0] && eventsData[0].Dates) {
      const dates = eventsData[0].Dates;
      showtimes = dates.filter(d => {
        const fullStr = (d.Date || '') + ' ' + (d.Day || '');
        return fullStr.includes(dateClean);
      });
    }

    if (showtimes.length === 0) {
      console.log(JSON.stringify({ error: "No showtimes found", showtimes: [] }));
      return;
    }

    browser = await puppeteer.launch({
      executablePath: getChromeExecutablePath(),
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();
    const firstEventId = showtimes[0].EventId;

    let capturedUuid = '';
    page.on('request', req => {
      const u = req.headers()['uuid'];
      if (u) capturedUuid = u;
    });

    // Establish initial session context on Cinema City tickets domain
    await page.goto(`https://tickets.cinema-city.co.il/order/${firstEventId}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await new Promise(r => setTimeout(r, 600));

    // Execute parallel in-page extraction for all daily showtimes
    const results = await page.evaluate(async (eventsList, sessionUuid) => {
      const fetchOne = async (ev) => {
        try {
          const reqHeaders = {
            'accept': 'application/json, text/plain, */*',
            'content-type': 'application/json'
          };
          if (sessionUuid) reqHeaders['uuid'] = sessionUuid;

          const presRes = await fetch(`https://tickets.cinema-city.co.il/api/presentations/${ev.EventId}`, { headers: reqHeaders });
          const presJson = await presRes.json();
          const pres = presJson ? presJson.presentation : null;

          let hourStr = ev.Hour || '';
          if (!hourStr && ev.Date) {
            const parts = ev.Date.split(' ');
            if (parts.length > 1) hourStr = parts[1].substring(0, 5);
          }

          if (!pres) {
            return {
              eventId: String(ev.EventId),
              hour: hourStr,
              dateTime: ev.Date,
              featureName: '',
              featureImageUrl: '',
              venueName: 'אולם',
              locationName: 'סינמה סיטי',
              totalSeats: 0,
              freeSeats: 0,
              occupiedSeats: 0,
              seatsStatus: {},
              seatplan: null
            };
          }

          if (!hourStr && pres.dateTime) {
            const parts = pres.dateTime.split(' ');
            if (parts.length > 1) hourStr = parts[1].substring(0, 5);
          }

          const [spRes, statusRes] = await Promise.all([
            fetch(`https://tickets.cinema-city.co.il/api/seats/seatplanV2?venueId=${pres.venueId}&seatplanId=${pres.seatplanId}`, { headers: reqHeaders }),
            fetch(`https://tickets.cinema-city.co.il/api/seats/seats-statusV2?presentationId=${ev.EventId}&venueTypeId=${pres.venueTypeId}&isReserved=${pres.isReserved ? 1 : 0}`, { headers: reqHeaders })
          ]);

          let spJson = null;
          let statusJson = null;
          try { spJson = await spRes.json(); } catch(e) {}
          try { statusJson = await statusRes.json(); } catch(e) {}

          const seats = statusJson && statusJson.seats ? statusJson.seats : {};

          let tot = 0;
          let free = 0;
          let occ = 0;
          for (const k in seats) {
            tot++;
            if (seats[k] === 0) free++;
            else occ++;
          }

          return {
            eventId: String(ev.EventId),
            hour: hourStr,
            dateTime: pres.dateTime || ev.Date,
            featureName: pres.featureName || '',
            featureImageUrl: pres.featureImageUrl || '',
            venueName: pres.venueName || 'אולם',
            locationName: pres.locationName || 'סינמה סיטי',
            totalSeats: tot,
            freeSeats: free,
            occupiedSeats: occ,
            seatsStatus: seats,
            seatplan: spJson ? (spJson.S || spJson) : null
          };
        } catch(e) {
          return {
            eventId: String(ev.EventId),
            hour: ev.Hour || (ev.Date ? ev.Date.split(' ')[1] : ''),
            dateTime: ev.Date,
            featureName: '',
            featureImageUrl: '',
            venueName: 'אולם',
            locationName: 'סינמה סיטי',
            totalSeats: 0,
            freeSeats: 0,
            occupiedSeats: 0,
            seatsStatus: {},
            seatplan: null
          };
        }
      };

      return await Promise.all(eventsList.map(fetchOne));
    }, showtimes, capturedUuid);

    console.log(JSON.stringify({ error: null, showtimes: results }));

  } catch (err) {
    console.log(JSON.stringify({ error: err.toString(), showtimes: [] }));
  } finally {
    if (browser) await browser.close();
  }
})();
