import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Timers and reminders, kept by the bridge and spoken when they come due.
 *
 * The agent session lives only as long as a turn needs it, so the clock has to
 * live here: one process-wide schedule, written to the workspace so a reminder
 * for tomorrow morning survives a restart tonight. When one is due the bridge
 * pushes it to every open interface (see server.mjs), which speaks it.
 *
 * A reminder that came due while the bridge was off fires as soon as it is
 * back — late, and marked as late, rather than silently never.
 */

export const MAX_REMINDERS = 100
/** setTimeout's ceiling. Longer waits are re-armed when the shorter one ends. */
const MAX_DELAY_MS = 2 ** 31 - 1

export class Reminders {
  /**
   * @param {string} file where the schedule is kept
   * @param {(r: {id: string, text: string, due: number, late: boolean}) => void} onDue
   */
  constructor(file, onDue, { now = () => Date.now() } = {}) {
    this.file = file
    this.onDue = onDue
    this.now = now
    this.items = []
    this.timer = null
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      if (Array.isArray(parsed)) {
        this.items = parsed.filter((r) => r && typeof r.text === 'string' && Number.isFinite(r.due))
      }
    } catch {
      // Nothing scheduled yet.
    }
  }

  /** Arm the clock. Separate from the constructor so tests and boot decide when. */
  start() {
    this.arm()
  }

  stop() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  save() {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.items, null, 2))
    renameSync(tmp, this.file)
  }

  list() {
    return [...this.items].sort((a, b) => a.due - b.due)
  }

  add({ text, due }) {
    const clean = String(text ?? '').replace(/\s+/g, ' ').trim()
    if (!clean) throw new Error('a reminder needs something to say')
    if (!Number.isFinite(due)) throw new Error('that time could not be understood')
    if (due <= this.now()) throw new Error('that time has already passed')
    if (this.items.length >= MAX_REMINDERS) throw new Error('too many reminders are pending')
    const next = this.items.reduce((max, r) => Math.max(max, Number(r.id.slice(1)) || 0), 0) + 1
    const item = { id: `r${next}`, text: clean.slice(0, 300), due, created: this.now() }
    this.items.push(item)
    this.save()
    this.arm()
    return item
  }

  cancel(id) {
    const i = this.items.findIndex((r) => r.id === id)
    if (i === -1) return null
    const [gone] = this.items.splice(i, 1)
    this.save()
    this.arm()
    return gone
  }

  /** Fire everything due, then sleep until the next one. */
  arm() {
    this.stop()
    const now = this.now()
    const due = this.items.filter((r) => r.due <= now)
    if (due.length) {
      this.items = this.items.filter((r) => r.due > now)
      this.save()
      for (const r of due) {
        // A minute's grace before calling it late: the timer itself can fire a
        // little after its mark, and that is not news worth announcing.
        const late = now - r.due > 60_000
        try {
          this.onDue({ id: r.id, text: r.text, due: r.due, late })
        } catch (err) {
          console.error('[jarvis] reminder delivery failed:', err)
        }
      }
    }
    const next = this.list()[0]
    if (!next) return
    this.timer = setTimeout(() => this.arm(), Math.min(Math.max(next.due - now, 0), MAX_DELAY_MS))
    // A pending reminder must not be the only thing keeping the process alive.
    this.timer.unref?.()
  }
}

/**
 * When a reminder should go off, from what the model asked for.
 *
 * Either a relative delay or a local wall-clock time. The wall-clock form is
 * read in the machine's own time zone — "2026-11-12T18:30" means half six here
 * — and a bare time ("18:30") means its next occurrence, today or tomorrow.
 */
export function resolveDue({ in_minutes, in_seconds, at }, now = new Date()) {
  const relative = (Number(in_minutes) || 0) * 60_000 + (Number(in_seconds) || 0) * 1000
  if (relative > 0) return now.getTime() + relative
  if (!at) throw new Error('give either a delay or a time')
  const s = String(at).trim()
  const timeOnly = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s)
  if (timeOnly) {
    const d = new Date(now)
    d.setHours(Number(timeOnly[1]), Number(timeOnly[2]), Number(timeOnly[3] ?? 0), 0)
    if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1)
    return d.getTime()
  }
  // Date-time with no zone is parsed as local time by the Date constructor,
  // which is exactly the reading wanted here; an explicit offset is honoured.
  const local = /^\d{4}-\d{2}-\d{2}[T ]\d{1,2}:\d{2}(:\d{2})?$/.test(s) ? s.replace(' ', 'T') : s
  const t = new Date(local).getTime()
  if (!Number.isFinite(t)) throw new Error(`"${s}" is not a time I can read`)
  return t
}

/** "Thursday 12 November, 18:30" — how a time is reported back to the model. */
export function describeTime(ms) {
  return new Date(ms).toLocaleString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  })
}
