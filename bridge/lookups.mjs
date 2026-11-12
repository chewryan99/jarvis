import { fetchText } from './net.mjs'

/**
 * The free lookups: weather, news and conversions.
 *
 * Each one is a keyless public service fetched through net.mjs, so the same
 * SSRF rules as the rest of the bridge apply — a feed URL the model was handed
 * by a web page cannot be pointed at the LAN. The parsing lives here as plain
 * functions so it can be tested without the network.
 */

const JSON_OPTS = { maxBytes: 2 * 1024 * 1024, timeoutMs: 15_000, accept: 'application/json' }

async function getJson(url) {
  const { text } = await fetchText(url, JSON_OPTS)
  return JSON.parse(text)
}

// -- weather (Open-Meteo) ----------------------------------------------------

/** WMO weather interpretation codes, in words that read aloud well. */
const WMO = {
  0: 'clear skies', 1: 'mainly clear', 2: 'partly cloudy', 3: 'overcast',
  45: 'fog', 48: 'freezing fog',
  51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle',
  56: 'freezing drizzle', 57: 'heavy freezing drizzle',
  61: 'light rain', 63: 'rain', 65: 'heavy rain',
  66: 'freezing rain', 67: 'heavy freezing rain',
  71: 'light snow', 73: 'snow', 75: 'heavy snow', 77: 'snow grains',
  80: 'light showers', 81: 'showers', 82: 'violent showers',
  85: 'snow showers', 86: 'heavy snow showers',
  95: 'thunderstorms', 96: 'thunderstorms with hail', 99: 'thunderstorms with heavy hail',
}
export const describeWeatherCode = (code) => WMO[code] ?? 'unsettled weather'

export async function geocode(name) {
  const url = new URL('https://geocoding-api.open-meteo.com/v1/search')
  url.searchParams.set('name', name)
  url.searchParams.set('count', '1')
  url.searchParams.set('language', 'en')
  const data = await getJson(url.href)
  const hit = data?.results?.[0]
  if (!hit) throw new Error(`no place called "${name}" was found`)
  return {
    name: [...new Set([hit.name, hit.admin1, hit.country].filter(Boolean))].join(', '),
    latitude: hit.latitude,
    longitude: hit.longitude,
  }
}

export async function weather({ location, days = 3, imperial = false }) {
  const place = await geocode(location)
  const url = new URL('https://api.open-meteo.com/v1/forecast')
  url.searchParams.set('latitude', String(place.latitude))
  url.searchParams.set('longitude', String(place.longitude))
  url.searchParams.set('current', 'temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,precipitation')
  url.searchParams.set('daily', 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset')
  url.searchParams.set('timezone', 'auto')
  url.searchParams.set('forecast_days', String(Math.min(Math.max(days, 1), 7)))
  if (imperial) {
    url.searchParams.set('temperature_unit', 'fahrenheit')
    url.searchParams.set('wind_speed_unit', 'mph')
    url.searchParams.set('precipitation_unit', 'inch')
  }
  return summariseWeather(place, await getJson(url.href), imperial)
}

/** Open-Meteo's parallel arrays, folded into something a model reads at a glance. */
export function summariseWeather(place, data, imperial = false) {
  const t = imperial ? '°F' : '°C'
  const wind = imperial ? 'mph' : 'km/h'
  const c = data.current ?? {}
  const d = data.daily ?? {}
  const daysOut = (d.time ?? []).map((date, i) => ({
    date,
    conditions: describeWeatherCode(d.weather_code?.[i]),
    high: `${Math.round(d.temperature_2m_max?.[i])}${t}`,
    low: `${Math.round(d.temperature_2m_min?.[i])}${t}`,
    chance_of_rain: d.precipitation_probability_max?.[i] == null ? null : `${d.precipitation_probability_max[i]}%`,
    sunrise: d.sunrise?.[i]?.slice(11) ?? null,
    sunset: d.sunset?.[i]?.slice(11) ?? null,
  }))
  return {
    place: place.name,
    local_time: c.time ?? null,
    now: {
      conditions: describeWeatherCode(c.weather_code),
      temperature: `${Math.round(c.temperature_2m)}${t}`,
      feels_like: `${Math.round(c.apparent_temperature)}${t}`,
      humidity: c.relative_humidity_2m == null ? null : `${c.relative_humidity_2m}%`,
      wind: `${Math.round(c.wind_speed_10m)} ${wind}`,
    },
    days: daysOut,
  }
}

// -- news (RSS and Atom) -----------------------------------------------------

export const DEFAULT_FEEDS = {
  'bbc-world': 'https://feeds.bbci.co.uk/news/world/rss.xml',
  'bbc-tech': 'https://feeds.bbci.co.uk/news/technology/rss.xml',
  'npr': 'https://feeds.npr.org/1001/rss.xml',
  'hacker-news': 'https://hnrss.org/frontpage',
  'the-verge': 'https://www.theverge.com/rss/index.xml',
}

/** JARVIS_NEWS_FEEDS="name=url,name=url" replaces the defaults entirely. */
export function feedsFromEnv(raw) {
  if (!raw?.trim()) return { ...DEFAULT_FEEDS }
  const out = {}
  for (const pair of raw.split(',')) {
    const eq = pair.indexOf('=')
    if (eq < 1) continue
    const name = pair.slice(0, eq).trim().toLowerCase()
    const url = pair.slice(eq + 1).trim()
    if (name && /^https?:\/\//i.test(url)) out[name] = url
  }
  return Object.keys(out).length ? out : { ...DEFAULT_FEEDS }
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
function decode(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m)
}

/** Text of the first <tag>, CDATA unwrapped, markup stripped, entities decoded. */
function field(xml, tags) {
  for (const tag of tags) {
    const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i').exec(xml)
    if (!m) continue
    const inner = m[1].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1')
    // Strip, decode, strip again: RSS descriptions often carry their HTML
    // entity-escaped ("&lt;p&gt;"), which only becomes markup after decoding.
    const text = decode(decode(inner.replace(/<[^>]*>/g, ' ')).replace(/<[^>]*>/g, ' '))
      .replace(/\s+/g, ' ')
      .trim()
    if (text) return text
  }
  return ''
}

function attr(xml, tagPattern, name) {
  const m = new RegExp(`<${tagPattern}\\b[^>]*\\s${name}=["']([^"']+)["']`, 'i').exec(xml)
  return m ? decode(m[1]) : ''
}

/** Items from an RSS 2.0 or Atom document. Tolerant, not a validator. */
export function parseFeed(xml, source = '') {
  const blocks = xml.match(/<item\b[\s\S]*?<\/item>|<entry\b[\s\S]*?<\/entry>/gi) ?? []
  return blocks.map((block) => {
    let link = field(block, ['link'])
    if (!/^https?:/i.test(link)) {
      link =
        attr(block, `link(?=[^>]*rel=["']alternate["'])`, 'href') ||
        attr(block, 'link', 'href') ||
        field(block, ['guid', 'id'])
    }
    const image =
      attr(block, 'media:thumbnail', 'url') ||
      attr(block, `media:content(?=[^>]*(?:medium=["']image|type=["']image))`, 'url') ||
      attr(block, `enclosure(?=[^>]*type=["']image)`, 'url') ||
      (/<img[^>]+src=["']([^"']+)["']/i.exec(decode(block))?.[1] ?? '')
    const summary = field(block, ['description', 'summary', 'content'])
    return {
      title: field(block, ['title']),
      source,
      published: field(block, ['pubDate', 'published', 'updated', 'dc:date']) || null,
      link: /^https?:/i.test(link) ? link : null,
      image: /^https?:/i.test(image) ? image : null,
      summary: summary.length > 220 ? `${summary.slice(0, 217)}...` : summary,
    }
  }).filter((item) => item.title)
}

export async function news({ feeds, sources, query, limit = 8 }) {
  const chosen = sources?.length ? sources.map((s) => s.toLowerCase()) : Object.keys(feeds)
  const unknown = chosen.filter((s) => !feeds[s])
  if (unknown.length) throw new Error(`unknown news source: ${unknown.join(', ')}. Available: ${Object.keys(feeds).join(', ')}`)
  const results = await Promise.allSettled(
    chosen.map(async (name) => {
      const { text } = await fetchText(feeds[name], {
        maxBytes: 3 * 1024 * 1024,
        timeoutMs: 15_000,
        accept: 'application/rss+xml,application/atom+xml,application/xml,text/xml,*/*;q=0.5',
      })
      return parseFeed(text, name)
    }),
  )
  const failed = chosen.filter((_, i) => results[i].status === 'rejected')
  // Interleave the feeds rather than concatenating them, so eight headlines
  // are a spread of sources and not eight from whichever was listed first.
  const lists = results.map((r) => (r.status === 'fulfilled' ? r.value : []))
  const words = String(query ?? '').toLowerCase().split(/\s+/).filter((w) => w.length >= 3)
  const matches = (item) =>
    !words.length || words.some((w) => `${item.title} ${item.summary}`.toLowerCase().includes(w))
  const items = []
  for (let i = 0; items.length < limit && lists.some((l) => i < l.length); i++) {
    for (const list of lists) {
      if (items.length >= limit) break
      if (list[i] && matches(list[i])) items.push(list[i])
    }
  }
  return { items, ...(failed.length ? { unavailable: failed } : {}) }
}

// -- conversions -------------------------------------------------------------

/** Each unit's size in its dimension's base unit: metres, kilograms, litres, metres per second. */
const UNITS = {
  length: {
    mm: 0.001, cm: 0.01, m: 1, km: 1000, in: 0.0254, ft: 0.3048, yd: 0.9144, mi: 1609.344, nmi: 1852,
  },
  mass: {
    mg: 1e-6, g: 0.001, kg: 1, t: 1000, oz: 0.028349523125, lb: 0.45359237, st: 6.35029318,
  },
  volume: {
    ml: 0.001, cl: 0.01, dl: 0.1, l: 1, tsp: 0.00492892159, tbsp: 0.0147867648, floz: 0.0295735296,
    cup: 0.2365882365, pt: 0.473176473, qt: 0.946352946, gal: 3.785411784, ukpt: 0.56826125, ukgal: 4.54609,
  },
  speed: { 'm/s': 1, 'km/h': 1 / 3.6, mph: 0.44704, kn: 0.514444 },
  area: { 'm2': 1, 'km2': 1e6, ha: 1e4, acre: 4046.8564224, 'ft2': 0.09290304, 'mi2': 2589988.110336 },
}

const ALIASES = {
  millimetre: 'mm', millimeter: 'mm', centimetre: 'cm', centimeter: 'cm', metre: 'm', meter: 'm',
  kilometre: 'km', kilometer: 'km', kms: 'km', inch: 'in', inches: 'in', '"': 'in', foot: 'ft', feet: 'ft',
  "'": 'ft', yard: 'yd', yards: 'yd', mile: 'mi', miles: 'mi', 'nautical mile': 'nmi',
  milligram: 'mg', gram: 'g', grams: 'g', kilogram: 'kg', kilo: 'kg', kilos: 'kg', kgs: 'kg', tonne: 't',
  ton: 't', ounce: 'oz', ounces: 'oz', pound: 'lb', pounds: 'lb', lbs: 'lb', stone: 'st',
  millilitre: 'ml', milliliter: 'ml', litre: 'l', liter: 'l', teaspoon: 'tsp', tablespoon: 'tbsp',
  'fluid ounce': 'floz', 'fl oz': 'floz', cups: 'cup', pint: 'pt', pints: 'pt', quart: 'qt', gallon: 'gal',
  gallons: 'gal', 'uk pint': 'ukpt', 'imperial pint': 'ukpt', 'uk gallon': 'ukgal', 'imperial gallon': 'ukgal',
  kph: 'km/h', kmh: 'km/h', 'kilometres per hour': 'km/h', 'kilometers per hour': 'km/h',
  'miles per hour': 'mph', knot: 'kn', knots: 'kn', mps: 'm/s',
  hectare: 'ha', hectares: 'ha', acres: 'acre', 'square metre': 'm2', 'square meter': 'm2', 'sq m': 'm2',
  'square kilometre': 'km2', 'square kilometer': 'km2', 'square foot': 'ft2', 'square feet': 'ft2',
  'sq ft': 'ft2', 'square mile': 'mi2', 'square miles': 'mi2',
  celsius: 'c', centigrade: 'c', '°c': 'c', fahrenheit: 'f', '°f': 'f', kelvin: 'k',
}

function canonicalUnit(raw) {
  const s = String(raw).trim().toLowerCase().replace(/\.$/, '')
  if (ALIASES[s]) return ALIASES[s]
  // "metres" -> "metre": plurals the alias table does not list.
  if (s.endsWith('s') && ALIASES[s.slice(0, -1)]) return ALIASES[s.slice(0, -1)]
  return s
}

const TEMPS = new Set(['c', 'f', 'k'])
function toKelvin(v, u) {
  return u === 'c' ? v + 273.15 : u === 'f' ? (v - 32) * (5 / 9) + 273.15 : v
}
function fromKelvin(v, u) {
  return u === 'c' ? v - 273.15 : u === 'f' ? (v - 273.15) * (9 / 5) + 32 : v
}

/** Physical units. Throws for currencies, mismatched dimensions and the unknown. */
export function convertUnits(amount, from, to) {
  const a = canonicalUnit(from)
  const b = canonicalUnit(to)
  if (TEMPS.has(a) && TEMPS.has(b)) {
    return { amount, from: a.toUpperCase(), to: b.toUpperCase(), result: fromKelvin(toKelvin(amount, a), b) }
  }
  for (const [dimension, table] of Object.entries(UNITS)) {
    if (a in table && b in table) {
      return { amount, from: a, to: b, dimension, result: (amount * table[a]) / table[b] }
    }
  }
  const known = (u) => TEMPS.has(u) || Object.values(UNITS).some((t) => u in t)
  if (known(a) && known(b)) throw new Error(`${from} and ${to} measure different things`)
  throw new Error(`unknown unit: ${known(a) ? to : from}`)
}

/** Three letters that are not a unit we know: "USD" yes, "cup" and "kph" no. */
export function isCurrencyCode(s) {
  const u = canonicalUnit(s)
  return /^[a-z]{3}$/i.test(String(s).trim()) && !TEMPS.has(u) && !Object.values(UNITS).some((t) => u in t)
}

/** Frankfurter (European Central Bank reference rates, updated each working day). */
export async function convertCurrency(amount, from, to) {
  const base = from.trim().toUpperCase()
  const target = to.trim().toUpperCase()
  const url = new URL('https://api.frankfurter.dev/v1/latest')
  url.searchParams.set('base', base)
  url.searchParams.set('symbols', target)
  let data
  try {
    data = await getJson(url.href)
  } catch (err) {
    if (/404|422|upstream said 4/.test(String(err.message))) {
      throw new Error(`no exchange rate for ${base} to ${target}; only the ~30 currencies the European Central Bank publishes are covered`)
    }
    throw err
  }
  const rate = data?.rates?.[target]
  if (!Number.isFinite(rate)) throw new Error(`no exchange rate for ${base} to ${target}`)
  return { amount, from: base, to: target, rate, result: amount * rate, rates_date: data.date }
}

/** Rounded for speaking: four significant figures, no float noise. */
export const tidy = (n) => Number(Number(n).toPrecision(4))
