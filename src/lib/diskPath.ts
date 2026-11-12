/**
 * Is this image source a file on this machine's disk — and if so, which?
 *
 * A page served over http cannot load `file:///…`, so a local image (a
 * screenshot, a generated render, a photograph) only appears if it is routed
 * through the bridge's /file endpoint. That makes this test the gate on every
 * local picture JARVIS shows: in the sanitiser, the blades and the orbits.
 *
 * It used to know only Unix roots (`/Users/…`, `/home/…`), so on Windows —
 * where everything lives at `C:\Users\…` — no local file was ever recognised
 * and every one rendered as "image unavailable" (adewaskar/jarvis#17). Drive
 * letters and UNC shares now count too, in raw and file:// form.
 *
 * Only real disk paths qualify. Treating every src that begins with a slash as
 * a file also caught the app's own assets, so `/vite.svg` turned into a read of
 * `/vite.svg` on the host and 404'd — hence the list of Unix roots rather than
 * a bare leading-slash test. The bridge still decides what it will serve.
 *
 * Kept in lib with no DOM or React in it, so the scene and the UI can share
 * one copy instead of three that drift apart.
 */

const UNIX_ROOT =
  /^\/(Users|home|root|Volumes|Applications|System|Library|private|tmp|var|opt|mnt|media|srv|data)\//

/** `C:\Users\…` or `C:/Users/…` */
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/

/** `\\server\share\…` */
const WINDOWS_UNC = /^\\\\[^\\/]+[\\/][^\\/]+/

/** The disk path behind `src`, or null when it is not a local file. */
export function diskPath(src: string): string | null {
  let path = String(src ?? '').trim()
  if (/^file:\/\//i.test(path)) {
    path = path.slice('file://'.length)
    // A file URL is percent-encoded ("My%20Pictures"); a bare path is not, and
    // decoding one could corrupt a name that really contains a percent sign.
    try {
      path = decodeURIComponent(path)
    } catch {
      // Malformed escapes: judge the path as written.
    }
    // file:///C:/Users/… leaves "/C:/Users/…" once the scheme is gone.
    if (/^\/[A-Za-z]:[\\/]/.test(path)) path = path.slice(1)
  }
  if (UNIX_ROOT.test(path) || WINDOWS_DRIVE.test(path) || WINDOWS_UNC.test(path)) return path
  return null
}
