import fs from 'node:fs'

/**
 * Minimal .env reader — enough for KEY=value files, no interpolation, no deps.
 * Existing process.env values always win, so systemd/pm2 env overrides the file.
 */
export function loadEnvFile(file) {
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return {}
  }
  const out = {}
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    out[key] = value
    if (process.env[key] === undefined) process.env[key] = value
  }
  return out
}
