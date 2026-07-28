const puppeteer = require('puppeteer-core');
const https = require('https');

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
  const eventsUrl = `https://www.cinema-city.co.il/tickets/Events?MovieId=6123&TheatreId=1170`;
  const eventsData = await httpGetJson(eventsUrl);
  let showtimes = eventsData[0].Dates.filter(d => (d.Date || '').includes('01/08'));

  console.log(`Found ${showtimes.length} showtimes for 01/08/2026`);

  const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
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

  console.log(`Navigating to order/${firstEventId}...`);
  await page.goto(`https://tickets.cinema-city.co.il/order/${firstEventId}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await new Promise(r => setTimeout(r, 600));

  console.log(`Captured session UUID: ${capturedUuid}`);

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

        if (!pres) return { eventId: ev.EventId, seatsCount: 0, err: 'no pres' };

        const [spRes, statusRes] = await Promise.all([
          fetch(`https://tickets.cinema-city.co.il/api/seats/seatplanV2?venueId=${pres.venueId}&seatplanId=${pres.seatplanId}`, { headers: reqHeaders }),
          fetch(`https://tickets.cinema-city.co.il/api/seats/seats-statusV2?presentationId=${ev.EventId}&venueTypeId=${pres.venueTypeId}&isReserved=${pres.isReserved ? 1 : 0}`, { headers: reqHeaders })
        ]);

        let spJson = null;
        let statusJson = null;
        try { spJson = await spRes.json(); } catch(e) {}
        try { statusJson = await statusRes.json(); } catch(e) {}

        const seats = statusJson && statusJson.seats ? statusJson.seats : {};
        return {
          eventId: ev.EventId,
          hour: ev.Hour || (ev.Date ? ev.Date.split(' ')[1] : ''),
          seatsCount: Object.keys(seats).length,
          spStatus: spRes.status,
          stStatus: statusRes.status,
          hasSpData: !!(spJson && (spJson.S || Object.keys(spJson).length > 0))
        };
      } catch(e) {
        return { eventId: ev.EventId, seatsCount: 0, err: e.toString() };
      }
    };

    return await Promise.all(eventsList.map(fetchOne));
  }, showtimes, capturedUuid);

  console.log('Results for 01/08:', JSON.stringify(results.slice(0, 5), null, 2));
  await browser.close();
})();
