/**
 * Makefile parser — pure, no I/O, so it is trivially testable.
 *
 * Extracts real targets plus the `## description` convention these projects use:
 *
 *     deploy: ## Full production deploy: pull main -> build -> PM2 reload
 *
 * Skips variable assignments (`SHELL := /bin/bash`), pattern rules (`%.o:`),
 * special targets (`.PHONY:`) and anything indented (recipe lines).
 */
const TARGET_RE = /^([A-Za-z0-9_.\-\/ ]+?)\s*:(?!=)\s*(.*)$/
const SECTION_RE = /^#+\s*-{2,}\s*(.+?)\s*$|^#+\s*(.+?)\s*-{3,}\s*$/

export function parseMakefile(text) {
  const targets = []
  const seen = new Set()
  let section = null

  for (const rawLine of String(text).split('\n')) {
    if (rawLine.startsWith('\t')) continue // recipe body

    const line = rawLine.trimEnd()
    if (!line.trim()) continue

    if (line.trimStart().startsWith('#')) {
      const m = SECTION_RE.exec(line.trim())
      if (m) {
        const name = (m[1] || m[2] || '').replace(/^-+|-+$/g, '').trim()
        if (name && name.length <= 40) section = name
      }
      continue
    }

    const m = TARGET_RE.exec(line)
    if (!m) continue

    const namesPart = m[1].trim()
    const rest = m[2] ?? ''
    if (!namesPart || namesPart.includes('=')) continue

    const descMatch = /##\s*(.*)$/.exec(rest)
    const description = descMatch ? descMatch[1].trim() : ''
    const prereqs = rest.replace(/##.*$/, '').trim()

    for (const name of namesPart.split(/\s+/)) {
      if (!name) continue
      if (name.startsWith('.')) continue        // .PHONY, .DEFAULT_GOAL
      if (name.includes('%')) continue          // pattern rule
      if (name.includes('$')) continue          // computed target name
      if (seen.has(name)) {
        // A later definition can add the `##` description (or vice versa) — keep the richer one.
        const prev = targets.find((t) => t.name === name)
        if (prev && !prev.description && description) prev.description = description
        continue
      }
      seen.add(name)
      targets.push({ name, description, section, prereqs })
    }
  }

  return targets
}

/** True when a target name looks destructive enough to demand a confirmation click. */
export function isDangerous(name, patterns) {
  const n = String(name).toLowerCase()
  return (patterns || []).some((p) => {
    const pat = String(p).toLowerCase()
    return n === pat || n.startsWith(`${pat}-`) || n.endsWith(`-${pat}`) || n.includes(pat)
  })
}
