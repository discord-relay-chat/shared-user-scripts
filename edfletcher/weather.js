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

/* globals config, DRCUserScript, scopedRedisClient, sendToBotChan, MessageEmbed */

const { eventName, data, state, isScheduled, constants } = DRCUserScript;
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

const AWHost = 'https://dataservice.accuweather.com';
const WeatherTextEmojis = {
  Sunny: '☀️',
  'Mostly Sunny': '☀️',
  'Partly Sunny': '⛅',
  'Intermittent Clouds': '⛅',
  'Hazy Sunshine': '🌫️',
  'Mostly Cloudy': '🌥️',
  Cloudy: '☁️',
  'Dreary (Overcast)': '☁️',
  Fog: '☁️',
  Clear: '☀️',
  'Mostly Clear': '☀️',
};

function awUnitToString(unitObj,  unitSep = ' ', type = 'Imperial', includeUnit = true) {
  let retStr = `${unitObj[type]?.Value}`;

  if (includeUnit) {
    retStr += `${unitSep}${unitObj[type]?.Unit}`;
  }

  return retStr;
}

async function main () {
  let matchedMessage;
  if (!isScheduled) {
    matchedMessage = canProcessCurrentEvent();
    if (!matchedMessage) {
      return;
    }
  }

  let curState = await state.get();
  let lookup;
  if (isScheduled) {
    lookup = data?.scriptArgs?.[0].replaceAll('"', '').replaceAll("'", '')
      ?? constants.SCHEDULED_WEATHER_CITY;
  }
  else {
    [[, lookup]] = matchedMessage;
  }

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

  if (isScheduled) {
    const awCache = curState?.awCache ?? {};
    let cityId = awCache[lookup];
    if (!cityId) {
      const awLuRes = await fetch(`${AWHost}/locations/v1/cities/search?apikey=${constants.AW_API_KEY}&q=${encodeURI(lookup)}`);
      if (awLuRes.ok) {
        const resJson = await awLuRes.json();
        if (resJson.length && resJson[0]?.Key) {
          awCache[lookup] = cityId = resJson[0].Key;
          await state.set({ ...curState, awCache });
        }
        else {
          console.error(`Bad AW lookup json for ${lookup}`, resJson);
        }
      }
      else {
        sendToBotChan(`Cannot find "${lookup}" at ${AWHost}!`);
      }
    }
  
    const awRes = await fetch(`${AWHost}/currentconditions/v1/${cityId}?details=true&apikey=${constants.AW_API_KEY}`);
    let desc = forecast;
    const embed = new MessageEmbed()
          .setTitle(`🌈 Weather for **${lookup}**`)
          .setColor('BLUE');

    if (awRes.ok) {
      const [{
        WeatherText,
        IsDayTime,
        RealFeelTemperature,
        TemperatureSummary,
        Wind,
        WindGust,
        Pressure,
        PressureTendency,
        PrecipitationSummary,
        Link,
      }] = await awRes.json();

      if (!IsDayTime) {
        embed.setColor('BLACK');
      }

      desc += '\n### Current conditions:\n' + 
        `${WeatherTextEmojis[WeatherText] ?? ''} ${WeatherText}`;

      embed.addField('🌡️ Temperature', `${awUnitToString(RealFeelTemperature, '')},  range of ` +
        `${awUnitToString(TemperatureSummary.Past24HourRange.Minimum)} to ` + 
        awUnitToString(TemperatureSummary.Past24HourRange.Maximum));

      embed.addField('🌬️ Winds', `${awUnitToString(Wind.Speed)} with gusts to ${awUnitToString(WindGust.Speed)}`);

      embed.addField('💥 Pressure', `${awUnitToString(Pressure)} and ` +
        `${PressureTendency.LocalizedText.slice(0, 1).toLowerCase()}${PressureTendency.LocalizedText.slice(1)}`);

      embed.addField('☔ Precipitation', `${awUnitToString(PrecipitationSummary.Precipitation)}; ` +
        `${awUnitToString(PrecipitationSummary.Past24Hours)} in the last 24h.`);

      embed.setURL(Link);
    }

    embed.setDescription(desc);

    await sendToBotChan({ embeds: [embed] }, true);
    return;
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
