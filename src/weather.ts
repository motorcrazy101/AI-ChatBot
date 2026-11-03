import axios from "axios";
import { EmbedBuilder } from "discord.js";
import { config } from "./config";
import { EMBED_COLOR, Feature, replyInCharacter, replyPlain } from "./featureKit";

/**
 * "aurora what's the weather in LA" — real forecast from Open-Meteo
 * (free, no key needed). Units from WEATHER_UNITS (default fahrenheit).
 */

const PATTERNS = [
  /\b(?:weather|forecast|temperature|temp)\b(?:\s+(?:like|be|going to be|gonna be|looking))?(?:\s+(?:today|tomorrow|tonight|this week|this weekend|right now|now|rn))?\s+(?:in|for|at|around|over)\s+([^?!\n]+)/i,
  /\b(?:is it|will it|gonna|going to)\s+(?:be\s+)?(?:rain|raining|snow|snowing|hot|cold|sunny|warm|windy|storm|stormy)\b[^?!\n]*?\s+(?:in|at)\s+([^?!\n]+)/i,
];
const NO_PLACE = /\b(?:what'?s|whats|how'?s|hows|what is|how is|check)\s+(?:the\s+)?(?:weather|forecast|temperature)\b/i;

const ALIASES: Record<string, string> = {
  la: "Los Angeles", "l.a.": "Los Angeles", nyc: "New York", ny: "New York", sf: "San Francisco",
  vegas: "Las Vegas", lv: "Las Vegas", dc: "Washington", philly: "Philadelphia", nola: "New Orleans",
  slc: "Salt Lake City", atl: "Atlanta", chi: "Chicago", sd: "San Diego", "the bay": "San Francisco",
};

const US_STATES: Record<string, string> = {
  al: "Alabama", ak: "Alaska", az: "Arizona", ar: "Arkansas", ca: "California", co: "Colorado",
  ct: "Connecticut", de: "Delaware", fl: "Florida", ga: "Georgia", hi: "Hawaii", id: "Idaho",
  il: "Illinois", in: "Indiana", ia: "Iowa", ks: "Kansas", ky: "Kentucky", la: "Louisiana",
  me: "Maine", md: "Maryland", ma: "Massachusetts", mi: "Michigan", mn: "Minnesota",
  ms: "Mississippi", mo: "Missouri", mt: "Montana", ne: "Nebraska", nv: "Nevada",
  nh: "New Hampshire", nj: "New Jersey", nm: "New Mexico", ny: "New York", nc: "North Carolina",
  nd: "North Dakota", oh: "Ohio", ok: "Oklahoma", or: "Oregon", pa: "Pennsylvania",
  ri: "Rhode Island", sc: "South Carolina", sd: "South Dakota", tn: "Tennessee", tx: "Texas",
  ut: "Utah", vt: "Vermont", va: "Virginia", wa: "Washington", wv: "West Virginia",
  wi: "Wisconsin", wy: "Wyoming",
};

/** Works out the place someone asked about, "" for "the default place", or null if not a weather question. */
export function parseWeatherRequest(text: string): string | null {
  for (const pattern of PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      const place = match[1]
        .replace(/\b(today|tomorrow|tonight|this week|this weekend|right now|now|rn|please|pls|like|at the moment)\b/gi, " ")
        .replace(/[.,]+$/, "")
        .replace(/\s+/g, " ")
        .trim();
      if (place) return place;
    }
  }
  return NO_PLACE.test(text) ? "" : null;
}

interface Place {
  name: string;
  admin1?: string;
  country?: string;
  country_code?: string;
  latitude: number;
  longitude: number;
}

async function findPlace(query: string): Promise<Place | null> {
  const [cityRaw, ...regionParts] = query.split(",").map((p) => p.trim());
  const city = ALIASES[cityRaw.toLowerCase()] ?? cityRaw;
  const regionRaw = regionParts.join(" ").toLowerCase();
  const region = US_STATES[regionRaw]?.toLowerCase() ?? regionRaw;

  const { data } = await axios.get("https://geocoding-api.open-meteo.com/v1/search", {
    params: { name: city, count: 10, language: "en", format: "json" },
    timeout: 10_000,
  });
  const results: Place[] = Array.isArray(data?.results) ? data.results : [];
  if (results.length === 0) return null;
  if (!region) return results[0];

  const matches = (r: Place) =>
    [r.admin1, r.country, r.country_code].some((v) => v && v.toLowerCase().startsWith(region));
  return results.find(matches) ?? results[0];
}

const CODES: Record<number, [string, string]> = {
  0: ["Clear sky", "☀️"], 1: ["Mostly clear", "🌤️"], 2: ["Partly cloudy", "⛅"], 3: ["Overcast", "☁️"],
  45: ["Foggy", "🌫️"], 48: ["Freezing fog", "🌫️"],
  51: ["Light drizzle", "🌦️"], 53: ["Drizzle", "🌦️"], 55: ["Heavy drizzle", "🌧️"],
  56: ["Freezing drizzle", "🌧️"], 57: ["Freezing drizzle", "🌧️"],
  61: ["Light rain", "🌦️"], 63: ["Rain", "🌧️"], 65: ["Heavy rain", "🌧️"],
  66: ["Freezing rain", "🌧️"], 67: ["Freezing rain", "🌧️"],
  71: ["Light snow", "🌨️"], 73: ["Snow", "🌨️"], 75: ["Heavy snow", "❄️"], 77: ["Snow grains", "🌨️"],
  80: ["Rain showers", "🌦️"], 81: ["Rain showers", "🌧️"], 82: ["Violent rain showers", "⛈️"],
  85: ["Snow showers", "🌨️"], 86: ["Heavy snow showers", "❄️"],
  95: ["Thunderstorm", "⛈️"], 96: ["Thunderstorm with hail", "⛈️"], 99: ["Thunderstorm with hail", "⛈️"],
};

function describe(code: number, isDay = true): [string, string] {
  const [label, emoji] = CODES[code] ?? ["Unknown", "🌡️"];
  if (!isDay && code <= 1) return [label, "🌙"];
  return [label, emoji];
}

export const weatherFeature: Feature = async (ctx) => {
  let placeQuery = parseWeatherRequest(ctx.text);
  if (placeQuery === null) return false;

  if (!placeQuery) placeQuery = config.weatherDefaultLocation;
  if (!placeQuery) {
    await replyPlain(ctx, "Where should I check? Try something like *what's the weather in Los Angeles*.");
    return true;
  }

  const place = await findPlace(placeQuery).catch((err) => {
    console.warn("[weather] Geocoding failed:", (err as Error).message);
    return undefined;
  });
  if (place === undefined) {
    await replyPlain(ctx, "My weather app isn't loading right now 😣 Try again in a bit.");
    return true;
  }
  if (!place) {
    await replyPlain(ctx, `I couldn't find a place called "${placeQuery}" 🤔`);
    return true;
  }

  const fahrenheit = config.weatherUnits !== "celsius";
  const { data } = await axios.get("https://api.open-meteo.com/v1/forecast", {
    params: {
      latitude: place.latitude,
      longitude: place.longitude,
      current: "temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,is_day",
      daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
      temperature_unit: fahrenheit ? "fahrenheit" : "celsius",
      wind_speed_unit: fahrenheit ? "mph" : "kmh",
      timezone: "auto",
      forecast_days: 3,
    },
    timeout: 10_000,
  });

  const unit = fahrenheit ? "°F" : "°C";
  const wind = fahrenheit ? "mph" : "km/h";
  const c = data?.current ?? {};
  const [label, emoji] = describe(Number(c.weather_code), c.is_day !== 0);
  const where = [place.name, place.admin1, place.country].filter(Boolean).join(", ");
  const temp = Math.round(c.temperature_2m);
  const feels = Math.round(c.apparent_temperature);

  const d = data?.daily ?? {};
  const days: string[] = [];
  const dayNames: string[] = Array.isArray(d.time) ? d.time : [];
  dayNames.forEach((date: string, i: number) => {
    const name =
      i === 0
        ? "Today"
        : new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
    const [dayLabel, dayEmoji] = describe(Number(d.weather_code?.[i]));
    const rain = d.precipitation_probability_max?.[i];
    days.push(
      `${dayEmoji} **${name}** · ${Math.round(d.temperature_2m_max?.[i])}${unit} / ${Math.round(d.temperature_2m_min?.[i])}${unit}` +
        ` · ${dayLabel}${typeof rain === "number" ? ` · ${rain}% rain` : ""}`
    );
  });

  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle(`${emoji} Weather in ${where}`.slice(0, 256))
    .setDescription(
      `**${temp}${unit}** (feels like ${feels}${unit}) · ${label}\n` +
        `💧 Humidity ${c.relative_humidity_2m}% · 💨 Wind ${Math.round(c.wind_speed_10m)} ${wind}\n\n` +
        days.join("\n")
    )
    .setFooter({ text: "Forecast by Open-Meteo.com" });

  const summary =
    `${where}: ${temp}${unit} (feels like ${feels}${unit}), ${label.toLowerCase()}, humidity ${c.relative_humidity_2m}%, ` +
    `wind ${Math.round(c.wind_speed_10m)} ${wind}. Next days: ${days.map((x) => x.replace(/\*\*/g, "")).join("; ")}`;

  await replyInCharacter(
    ctx,
    `You checked the weather for ${ctx.user.name}. Real data: ${summary}. ` +
      "Tell them about it in character in 1-2 sentences, using only these real numbers.",
    { embed, fallback: `Here's the weather in ${place.name}!`, logExtra: `[weather] ${summary}` }
  );
  return true;
};
