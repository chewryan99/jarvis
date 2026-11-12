import { test } from 'node:test'
import assert from 'node:assert/strict'
import { imageFilename, pollinationsUrl } from '../bridge/imagine.mjs'
import { decideTool } from '../bridge/policy.mjs'

test('the Pollinations request carries the prompt and keeps it out of the public feed', () => {
  const url = pollinationsUrl({ prompt: 'Mark VII / armour & co?', width: 512, height: 768, seed: 7 })
  assert.equal(url.origin, 'https://image.pollinations.ai')
  // The prompt is one path segment: slashes and query characters are escaped.
  assert.equal(url.pathname, '/prompt/' + encodeURIComponent('Mark VII / armour & co?'))
  assert.equal(url.searchParams.get('width'), '512')
  assert.equal(url.searchParams.get('height'), '768')
  assert.equal(url.searchParams.get('seed'), '7')
  assert.equal(url.searchParams.get('nofeed'), 'true')
  // These answer 401 without a key, so an anonymous request leaves them off.
  assert.equal(url.searchParams.get('private'), null)
  assert.equal(url.searchParams.get('safe'), null)
  const keyed = pollinationsUrl({ prompt: 'x' }, { keyed: true })
  assert.equal(keyed.origin, 'https://gen.pollinations.ai')
  assert.equal(keyed.searchParams.get('private'), 'true')
  assert.equal(keyed.searchParams.get('safe'), 'true')
  assert.equal(keyed.searchParams.get('nologo'), 'true')
})

test('without a seed, each picture gets a fresh one', () => {
  const a = pollinationsUrl({ prompt: 'x' }).searchParams.get('seed')
  const b = pollinationsUrl({ prompt: 'x' }).searchParams.get('seed')
  assert.match(a, /^\d+$/)
  assert.notEqual(a, b)
})

test('filenames are sortable, safe and say what the picture is', () => {
  const name = imageFilename('The Mark VII suit, in a ../../ workshop!', 'jpg', new Date('2026-11-12T08:30:15.123Z'))
  assert.equal(name, '2026-11-12T08-30-15-the-mark-vii-suit-in-a-workshop.jpg')
  assert.equal(imageFilename('???', 'png', new Date('2026-01-01T00:00:00Z')), '2026-01-01T00-00-00.png')
})

test('image generation runs in read-only mode', () => {
  assert.equal(decideTool('mcp__jarvis_imagine__generate_image'), true)
})
