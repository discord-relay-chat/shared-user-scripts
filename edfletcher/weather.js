// `weather`
//
// A user script that enables weather lookups in any channel from the configured DRC nickname by saying a
// particularly-worded phrase. The response is said, as your user, in that channel.
//
// Specfically the regex `msgMatcher` below defines the phrase, but as an example, any of these would result
// in a lookup for Los Angeles, CA:
//
//  The weather in Los Angeles, CA is...
//  The weather in Los Angeles is..
//  The forecast for Los Angeles..
//  The forecast for Los Angeles, CA is.....
//  The weather for Los Angeles, CA is...
//  The forecast in Los Angeles...
//
// Lookups are cached in order to be conscientious API consumers; Nominatim (the OpenStreetMap
// API used for geocoding place names) strongly encourages this and may block IPs otherwise.
//
// The data is sourced via the National Weather Service APIs, so this is US-only.
//

/* globals config, DRCUserScript, scopedRedisClient */

const { eventName, data, state } = DRCUserScript;
const msgMatcher = /^\s*The\s+(?:weather|forecast)\s+(?:for|in)\s+(.*?)(?:\s+is)?\s?\.{2,}/g;

async function lookupLatLng (search) {
  console.log(`Fetching lat,lon for "${search}"...`);
  const q = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(search)}&format=json`;
  const lookupRes = await fetch(q);

  if (lookupRes.ok) {
    const results = await lookupRes.json();
    const adminResults = results
      .filter(({ type }) => type === 'administrative')
      .sort(({ importanceA }, { importanceB }) => importanceB - importanceA);

    if (adminResults.length) {
      const [{ lat, lon }] = adminResults;
      console.log(`Got ${lat},${lon} for "${search}"`);
      return encodeURIComponent(`${lat},${lon}`);
    }

    console.warn(`No admin results for "${search}"!`, results);
  } else {
    console.error(`Fetch failed: ${q}`, lookupRes.status);
  }

  return null;
}

async function lookupNwsStation (latLonStr) {
  const nwsStationsRes = await fetch(`https://api.weather.gov/points/${latLonStr}`);

  if (nwsStationsRes.ok) {
    const { properties: { gridId, gridX, gridY } } = await nwsStationsRes.json();
    if (gridId && gridX && gridY) {
      return `${gridId}/${gridX},${gridY}`;
    }
  } else {
    console.error(`Failed to fetch NWS stations for ${latLonStr}`, nwsStationsRes.status);
  }

  return null;
}

async function nwsFetchForecastForStation (stationString) {
  const q = 'https://api.weather.gov/gridpoints/' + stationString + '/forecast';
  const res = await fetch(q);

  if (res.ok) {
    const bodyObj = await res.json();
    const [today] = bodyObj?.properties?.periods;
    return today?.detailedForecast;
  } else {
    console.error(`NWS Lookup ${q} failed: ${res.status}`, res);
  }

  return null;
}

function canProcessCurrentEvent () {
  let matchedMessage;

  if (eventName !== 'irc:message' ||
        data?.nick !== config.irc.registered[data.__drcNetwork].user.nick ||
        (matchedMessage = [...data.message?.matchAll(msgMatcher)]).length === 0) {
    return null;
  }

  return matchedMessage;
}

async function main () {
  const matchedMessage = canProcessCurrentEvent();
  if (!matchedMessage) {
    return;
  }

  let curState = await state.get();
  const [[, lookup]] = matchedMessage;
  const luCache = curState?.luCache ?? {};

  if (!luCache[lookup]) {
    luCache[lookup] = await lookupLatLng(lookup);
    curState = { ...curState, luCache, __dirty: true };
  }

  if (!luCache[lookup]) {
    console.error('Geocoding lookup failed!');
    return;
  }

  const staCache = curState?.staCache ?? {};
  if (!staCache[luCache[lookup]]) {
    staCache[luCache[lookup]] = await lookupNwsStation(luCache[lookup]);
    curState = { ...curState, staCache, __dirty: true };
  }

  if (curState.__dirty) {
    delete curState.__dirty;
    await state.set(curState);
  }

  if (!staCache) {
    console.error('NWS Station lookup failed!');
    return;
  }

  let forecast = await nwsFetchForecastForStation(staCache[luCache[lookup]]);

  if (!staCache || !forecast) {
    forecast = `Unable to find results for "${lookup}"!`;
  }

  return scopedRedisClient((client, prefix) => client.publish(prefix, JSON.stringify({
    type: 'irc:say',
    data: {
      network: {
        name: data.__drcNetwork
      },
      channel: data.target.replace('#', ''),
      message: forecast
    }
  })));
}

main();
