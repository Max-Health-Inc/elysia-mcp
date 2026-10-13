// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: Apache-2.0

import console from 'node:console'
import { readFile } from 'node:fs/promises'
import process from 'node:process'
import { URL } from 'node:url'

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const failures = []

for (const subpath of Object.keys(pkg.exports)) {
  const specifier = pkg.name + subpath.slice(1)
  try {
    const mod = await import(specifier)
    if (Object.keys(mod).length === 0) failures.push(`${specifier}: no exports`)
  } catch (error) {
    failures.push(`${specifier}: ${error.message}`)
  }
}

if (failures.length > 0) {
  console.error(failures.join('\n'))
  process.exit(1)
}
console.log(`node ${process.version} imported ${Object.keys(pkg.exports).length} entry points`)
