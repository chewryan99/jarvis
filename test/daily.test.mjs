import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore, memoryPrompt, MAX_NOTE_CHARS } from '../bridge/memory.mjs'
import { Reminders, resolveDue } from '../bridge/reminders.mjs'
import {
  convertUnits,
  DEFAULT_FEEDS,
  feedsFromEnv,
  isCurrencyCode,
  parseFeed,
  summariseWeather,
  tidy,
} from '../bridge/lookups.mjs'
import { localIso } from '../bridge/daily.mjs'
import { decideTool } from '../bridge/policy.mjs'

const scratch = () => mkdtempSync(join(tmpdir(), 'jarvis-daily-'))

// -- memory ------------------------------------------------------------------

test('memory keeps facts across restarts, without duplicates', () => {
  const file = join(scratch(), 'memory.json')
  const a = new MemoryStore(file)
  const first = a.add('  Lives in   Kuala Lumpur ')
  assert.equal(first.text, 'Lives in Kuala Lumpur')
  assert.equal(a.add('lives in kuala lumpur').id, first.id, 'same fact twice is one note')
  a.add('Drinks his coffee black')
  const b = new MemoryStore(file)
  assert.deepEqual(b.list().map((n) => n.text), ['Lives in Kuala Lumpur', 'Drinks his coffee black'])
  assert.equal(b.add('Has a cat called Mochi').id, 'm3')
})

test('memory search, forget and limits', () => {
  const m = new MemoryStore(join(scratch(), 'memory.json'))
  m.add('Wife Anna, birthday third of March')
  m.add('Car plate WXY 1234')
  assert.deepEqual(m.search('when is anna birthday').map((n) => n.id), ['m1'])
  assert.equal(m.search('').length, 2, 'no query lists everything')
  assert.equal(m.remove('m1').text, 'Wife Anna, birthday third of March')
  assert.equal(m.remove('m1'), null)
  assert.throws(() => m.add('   '), /nothing to remember/)
  assert.throws(() => m.add('x'.repeat(MAX_NOTE_CHARS + 1)), /at most/)
})

test('remembered facts reach the prompt framed as facts, newest first', () => {
  const m = new MemoryStore(join(scratch(), 'memory.json'))
  assert.equal(memoryPrompt(m), '')
  m.add('Name is Ryan')
  m.add('Prefers Celsius')
  const prompt = memoryPrompt(m)
  assert.match(prompt, /not instructions/)
  assert.ok(prompt.indexOf('Prefers Celsius') < prompt.indexOf('Name is Ryan'))
})

// -- reminders ---------------------------------------------------------------

test('reminder times: delays, bare clock times and local date-times', () => {
  const now = new Date(2026, 10, 12, 14, 0, 0) // 12 Nov 2026, 14:00 local
  assert.equal(resolveDue({ in_minutes: 20 }, now), now.getTime() + 20 * 60_000)
  assert.equal(resolveDue({ in_minutes: 1, in_seconds: 30 }, now), now.getTime() + 90_000)
  assert.equal(resolveDue({ at: '18:30' }, now), new Date(2026, 10, 12, 18, 30).getTime())
  assert.equal(resolveDue({ at: '09:00' }, now), new Date(2026, 10, 13, 9, 0).getTime(), 'a passed time means tomorrow')
  assert.equal(resolveDue({ at: '2026-11-20T07:15' }, now), new Date(2026, 10, 20, 7, 15).getTime())
  assert.throws(() => resolveDue({}, now), /delay or a time/)
  assert.throws(() => resolveDue({ at: 'teatime' }, now), /not a time/)
})

test('reminders persist, fire when due, and report late ones as late', async () => {
  const file = join(scratch(), 'reminders.json')
  let clock = 1_000_000
  const fired = []
  const r = new Reminders(file, (x) => fired.push(x), { now: () => clock })
  assert.throws(() => r.add({ text: 'too late', due: clock - 1 }), /already passed/)
  const soon = r.add({ text: 'Pizza is ready', due: clock + 50 })
  r.add({ text: 'Call mum', due: clock + 10 * 60_000 })
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).length, 2)
  assert.equal(r.cancel('r99'), null)

  // Restart after both have passed: one eleven minutes ago, one within the
  // minute's grace, which is not worth calling late.
  r.stop()
  clock += 11 * 60_000
  const again = new Reminders(file, (x) => fired.push(x), { now: () => clock })
  again.start()
  again.stop()
  assert.deepEqual(fired.map((f) => [f.id, f.late]), [[soon.id, true], ['r2', false]])
  assert.equal(again.list().length, 0)
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).length, 0, 'fired reminders are cleared from disk')
})

test('a reminder fires on its timer', async () => {
  const fired = []
  const r = new Reminders(join(scratch(), 'reminders.json'), (x) => fired.push(x))
  r.add({ text: 'Tea', due: Date.now() + 30 })
  await new Promise((res) => setTimeout(res, 120))
  r.stop()
  assert.equal(fired.length, 1)
  assert.equal(fired[0].text, 'Tea')
  assert.equal(fired[0].late, false)
})

test('local ISO times are what set_reminder accepts', () => {
  assert.equal(localIso(new Date(2026, 0, 5, 7, 3)), '2026-01-05T07:03')
})

// -- news --------------------------------------------------------------------

test('RSS items come out with title, link, date and thumbnail', () => {
  const rss = `<?xml version="1.0"?><rss xmlns:media="http://search.yahoo.com/mrss/"><channel>
    <title>Feed</title>
    <item><title><![CDATA[Starship &amp; the tower]]></title><link>https://example.com/a</link>
      <pubDate>Thu, 12 Nov 2026 08:00:00 GMT</pubDate>
      <description>&lt;p&gt;Booster caught.&lt;/p&gt;</description>
      <media:thumbnail width="240" url="https://img.example.com/a.jpg"/></item>
    <item><title>Second</title><guid>https://example.com/b</guid></item>
  </channel></rss>`
  const items = parseFeed(rss, 'test')
  assert.equal(items.length, 2)
  assert.deepEqual(items[0], {
    title: 'Starship & the tower',
    source: 'test',
    published: 'Thu, 12 Nov 2026 08:00:00 GMT',
    link: 'https://example.com/a',
    image: 'https://img.example.com/a.jpg',
    summary: 'Booster caught.',
  })
  assert.equal(items[1].link, 'https://example.com/b')
})

test('Atom entries use the alternate link', () => {
  const atom = `<feed xmlns="http://www.w3.org/2005/Atom">
    <entry><title type="html">A &#8220;quoted&#8221; headline</title>
      <link rel="replies" href="https://example.com/comments"/>
      <link rel="alternate" type="text/html" href="https://example.com/story"/>
      <published>2026-11-12T09:00:00Z</published>
      <summary>Short.</summary></entry></feed>`
  const [item] = parseFeed(atom, 'verge')
  assert.equal(item.title, 'A “quoted” headline')
  assert.equal(item.link, 'https://example.com/story')
  assert.equal(item.published, '2026-11-12T09:00:00Z')
})

test('news sources come from JARVIS_NEWS_FEEDS, or the defaults', () => {
  assert.deepEqual(feedsFromEnv(''), DEFAULT_FEEDS)
  assert.deepEqual(feedsFromEnv('Star=https://www.thestar.com.my/rss/News, bad=ftp://x, =https://y'), {
    star: 'https://www.thestar.com.my/rss/News',
  })
  assert.deepEqual(feedsFromEnv('nonsense'), DEFAULT_FEEDS)
})

// -- conversions and weather -------------------------------------------------

test('unit conversions across dimensions and spellings', () => {
  assert.equal(tidy(convertUnits(10, 'km', 'miles').result), 6.214)
  assert.equal(tidy(convertUnits(5, 'feet', 'metres').result), 1.524)
  assert.equal(tidy(convertUnits(100, 'Fahrenheit', '°C').result), 37.78)
  assert.equal(tidy(convertUnits(1, 'kg', 'lbs').result), 2.205)
  assert.equal(tidy(convertUnits(2, 'cups', 'ml').result), 473.2)
  assert.equal(tidy(convertUnits(100, 'kph', 'mph').result), 62.14)
  assert.throws(() => convertUnits(1, 'kg', 'km'), /different things/)
  assert.throws(() => convertUnits(1, 'furlong', 'km'), /unknown unit: furlong/)
})

test('three-letter units are not mistaken for currencies', () => {
  assert.equal(isCurrencyCode('USD'), true)
  assert.equal(isCurrencyCode('myr'), true)
  assert.equal(isCurrencyCode('cup'), false)
  assert.equal(isCurrencyCode('kph'), false)
  assert.equal(isCurrencyCode('mph'), false)
  assert.equal(isCurrencyCode('pounds'), false)
})

test('Open-Meteo responses are summarised in words', () => {
  const out = summariseWeather(
    { name: 'Kuala Lumpur, Malaysia' },
    {
      current: { time: '2026-11-12T15:00', temperature_2m: 31.4, apparent_temperature: 36.2, relative_humidity_2m: 70, weather_code: 95, wind_speed_10m: 9.6 },
      daily: {
        time: ['2026-11-12'],
        weather_code: [80],
        temperature_2m_max: [32.6],
        temperature_2m_min: [24.1],
        precipitation_probability_max: [85],
        sunrise: ['2026-11-12T07:05'],
        sunset: ['2026-11-12T19:08'],
      },
    },
  )
  assert.equal(out.now.conditions, 'thunderstorms')
  assert.equal(out.now.temperature, '31°C')
  assert.deepEqual(out.days[0], {
    date: '2026-11-12', conditions: 'light showers', high: '33°C', low: '24°C',
    chance_of_rain: '85%', sunrise: '07:05', sunset: '19:08',
  })
})

test('the everyday tools run in read-only mode', () => {
  for (const t of ['current_time', 'remember', 'set_reminder', 'weather', 'news', 'convert']) {
    assert.equal(decideTool(`mcp__jarvis_daily__${t}`), true, t)
  }
})
