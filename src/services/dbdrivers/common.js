import { parseBytes } from '../../util/units.js'

/**
 * Shared validation for engine settings.
 *
 * Every driver declares its tunables up front; a key that is not on that list
 * never reaches the engine, and a value is parsed into a number (or matched
 * against an enum) before it is formatted back out by us. Nothing the browser
 * typed is ever interpolated raw into SQL or a CLI argument.
 */
export function validateSetting(tunable, rawValue) {
  if (!tunable) {
    const err = new Error('Unknown setting')
    err.status = 400
    throw err
  }

  const fail = (msg) => {
    const err = new Error(`${tunable.label || tunable.key}: ${msg}`)
    err.status = 400
    throw err
  }


  switch (tunable.kind) {
    case 'bytes': {
      let bytes
      try {
        bytes = parseBytes(rawValue)
      } catch (err) {
        fail(err.message)
      }
      if (bytes === null) fail('a size is required')
      if (tunable.min !== undefined && bytes < tunable.min) fail(`must be at least ${tunable.min} bytes`)
      if (tunable.max !== undefined && bytes > tunable.max) fail(`must be at most ${tunable.max} bytes`)
      return bytes
    }
    case 'int': {
      const value = Number(rawValue)
      if (!Number.isInteger(value)) fail('must be a whole number')
      if (tunable.min !== undefined && value < tunable.min) fail(`must be at least ${tunable.min}`)
      if (tunable.max !== undefined && value > tunable.max) fail(`must be at most ${tunable.max}`)
      return value
    }
    case 'float': {
      const value = Number(rawValue)
      if (!Number.isFinite(value)) fail('must be a number')
      if (tunable.min !== undefined && value < tunable.min) fail(`must be at least ${tunable.min}`)
      if (tunable.max !== undefined && value > tunable.max) fail(`must be at most ${tunable.max}`)
      return value
    }
    case 'enum': {
      const value = String(rawValue)
      if (!tunable.options.includes(value)) fail(`must be one of ${tunable.options.join(', ')}`)
      return value
    }
    default:
      fail(`unsupported setting kind "${tunable.kind}"`)
      return null
  }
}

export function findTunable(driver, key) {
  return (driver.tunables || []).find((t) => t.key === key) || null
}

/** Bytes -> the unit suffix form Postgres/MySQL accept in a config value. */
export function bytesToMegabyteString(bytes) {
  const mb = Math.max(1, Math.round(bytes / 1024 ** 2))
  return `${mb}MB`
}

export function firstLine(text) {
  return String(text || '').split('\n').map((l) => l.trim()).filter(Boolean)[0] || ''
}
