import { test } from 'node:test'
import assert from 'node:assert/strict'

// src/ is TypeScript. Node strips the types itself from 22.18 / 23.6 on; on an
// older Node there is nothing to test this file with, so the tests skip.
let diskPath = null
try {
  ;({ diskPath } = await import('../src/lib/diskPath.ts'))
} catch {
  diskPath = null
}
const opts = { skip: diskPath ? false : 'this Node cannot import TypeScript directly' }

test('Unix paths are recognised as before, and app assets are not', opts, () => {
  assert.equal(diskPath('/Users/you/shot.png'), '/Users/you/shot.png')
  assert.equal(diskPath('file:///tmp/render.png'), '/tmp/render.png')
  assert.equal(diskPath('/vite.svg'), null)
  assert.equal(diskPath('/assets/logo.png'), null)
})

test('Windows drive paths are local files (adewaskar/jarvis#17)', opts, () => {
  const p = 'C:\\Users\\kingj\\.jarvis\\workspace\\images\\suit.jpg'
  assert.equal(diskPath(p), p)
  assert.equal(diskPath('D:/Pictures/cat.png'), 'D:/Pictures/cat.png')
  assert.equal(diskPath('file:///C:/Users/kingj/My%20Pictures/a.png'), 'C:/Users/kingj/My Pictures/a.png')
  assert.equal(diskPath('\\\\nas\\photos\\2026\\a.jpg'), '\\\\nas\\photos\\2026\\a.jpg')
})

test('web, data and relative sources are left alone', opts, () => {
  for (const src of ['https://example.com/a.png', 'data:image/png;base64,AAAA', 'blob:http://x/1', 'images/a.png', 'C:relative.png', '']) {
    assert.equal(diskPath(src), null, src)
  }
})
