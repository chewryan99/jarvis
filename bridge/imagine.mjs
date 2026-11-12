import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { openRemote, PROXY_UA, vetTarget } from './net.mjs'

/**
 * JARVIS's free image generator, on Pollinations.
 *
 * Pollinations serves a picture straight back from a GET with the prompt in the
 * path — no account, no key, no bill. That makes it the right default for an
 * assistant whose only subscription is Claude Code: "generate an image of the
 * Mark VII suit" works on a fresh install.
 *
 * The URL is built and fetched here rather than handed to the model to paste,
 * for two reasons. The persona tells JARVIS never to put an address he
 * assembled himself on screen — a guessed URL is a broken image — and a tool
 * result is exactly what makes a URL trustworthy. And saving the bytes means
 * the picture is a file he can show, orbit or come back to, rather than a
 * request that re-renders (differently) every time the page loads.
 *
 * Prompts leave the machine in a URL, so the request asks Pollinations to keep
 * them out of its public feed. Set POLLINATIONS_API_KEY if their anonymous tier
 * ever starts asking for one.
 */

/**
 * Two front doors. The newer one renders with better models but answers 401
 * to anything without a key (cached repeats aside, which is what makes it look
 * open from a quick curl); the legacy one still serves anonymous requests, at
 * one picture per 45 seconds per IP. Measured November 2026.
 */
const KEYED_ENDPOINT = 'https://gen.pollinations.ai/image/'
const FREE_ENDPOINT = 'https://image.pollinations.ai/prompt/'

/** Pictures are a few hundred KB; anything near this is not a picture. */
const MAX_BYTES = 20 * 1024 * 1024

/** Generation is slow when the free tier is busy, and that is not a failure. */
const TIMEOUT_MS = 120_000

const EXTENSIONS = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }

const DESCRIPTION = `Generate an image from a text prompt, free, and save it to disk.

Returns the saved file's absolute path. Show it with the display tool or a blade
(kind "image") using that path exactly — do not describe a picture you have not
shown, and do not build a Pollinations URL yourself.

Write the prompt as a description of the picture: subject, setting, style,
lighting, composition. "The Mark VII armour standing in a dark workshop, studio
lighting, photorealistic" beats "iron man".

One call per picture. Takes a few seconds, longer when the service is busy.`

const schema = {
  prompt: z.string().min(1).max(2000).describe('What the picture should show, in descriptive detail.'),
  width: z.number().int().min(256).max(2048).optional().describe('Pixels. Default 1024.'),
  height: z.number().int().min(256).max(2048).optional().describe('Pixels. Default 1024.'),
  seed: z.number().int().min(0).optional().describe('Repeat a seed to reproduce a picture; omit for a new one.'),
}

/** The request URL for one picture. Exported for the tests. */
export function pollinationsUrl({ prompt, width = 1024, height = 1024, seed }, { keyed = false } = {}) {
  const url = new URL((keyed ? KEYED_ENDPOINT : FREE_ENDPOINT) + encodeURIComponent(prompt))
  url.searchParams.set('width', String(width))
  url.searchParams.set('height', String(height))
  url.searchParams.set('seed', String(seed ?? Math.floor(Math.random() * 2 ** 31)))
  // Anonymous requests may ask to stay out of the public feed; the rest of the
  // privacy and filtering switches answer 401 without a key (measured Nov 2026).
  url.searchParams.set('nofeed', 'true')
  if (keyed) {
    url.searchParams.set('nologo', 'true')
    url.searchParams.set('private', 'true')
    url.searchParams.set('safe', 'true')
  }
  return url
}

/** A filename that says what the picture is and sorts by when it was made. */
export function imageFilename(prompt, ext, now = new Date()) {
  const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const slug = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return `${stamp}${slug ? `-${slug}` : ''}.${ext}`
}

async function fetchImage(url, key) {
  const headers = { 'user-agent': PROXY_UA, accept: 'image/*', 'accept-encoding': 'identity' }
  if (key) headers.authorization = `Bearer ${key}`
  const { res } = await openRemote(vetTarget(url.href), headers, TIMEOUT_MS)
  const status = res.statusCode ?? 0
  const type = String(res.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
  if (status === 402 || status === 429) {
    res.resume()
    throw new Error('the free tier allows one picture every 45 seconds, so wait a moment and try again')
  }
  if (status !== 200 || !type.startsWith('image/')) {
    res.resume()
    throw new Error(`Pollinations answered ${status}${type ? ` (${type})` : ''}`)
  }
  const chunks = []
  let size = 0
  for await (const chunk of res) {
    size += chunk.length
    if (size > MAX_BYTES) {
      res.destroy()
      throw new Error('the image was larger than expected')
    }
    chunks.push(chunk)
  }
  return { bytes: Buffer.concat(chunks), type }
}

/** Generate one picture and save it under outDir. Resolves with its path. */
export async function generateImage(args, outDir) {
  const key = process.env.POLLINATIONS_API_KEY?.trim()
  const { bytes, type } = await fetchImage(pollinationsUrl(args, { keyed: Boolean(key) }), key)
  await mkdir(outDir, { recursive: true })
  const path = join(outDir, imageFilename(args.prompt, EXTENSIONS[type] ?? 'jpg'))
  await writeFile(path, bytes)
  return path
}

export function imagineServer({ outDir }) {
  return createSdkMcpServer({
    name: 'jarvis_imagine',
    version: '1.0.0',
    tools: [
      tool('generate_image', DESCRIPTION, schema, async (args) => {
        try {
          const path = await generateImage(args, outDir)
          return { content: [{ type: 'text', text: `Saved: ${path}` }] }
        } catch (err) {
          return {
            content: [
              {
                type: 'text',
                text: `Image generation failed: ${err.message}. Tell the user briefly, and offer to try again.`,
              },
            ],
            isError: true,
          }
        }
      }),
    ],
  })
}
