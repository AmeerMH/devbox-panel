#!/usr/bin/env node
import readline from 'node:readline'
import { hashPassword } from '../src/auth.js'

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })

// Hide the typed password without pulling in a dependency.
const origWrite = rl._writeToOutput?.bind(rl)
let hiding = false
rl._writeToOutput = function (str) {
  if (hiding && !str.includes('Password')) origWrite('*')
  else origWrite(str)
}

rl.question('Password for the panel: ', (answer) => {
  hiding = false
  rl.close()
  const pw = answer.trim()
  if (pw.length < 10) {
    console.error('\nRefusing: use at least 10 characters. This panel can deploy and restart everything on the box.')
    process.exit(1)
  }
  console.log('\n\nAdd this line to .env:\n')
  console.log(`PANEL_PASSWORD_HASH=${hashPassword(pw)}\n`)
})
hiding = true
