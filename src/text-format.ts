// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: Apache-2.0

/** Encoding of a tool result's `content[].text`; `structuredContent` always stays JSON per the MCP spec. */

import { encode as toonEncode } from '@toon-format/toon'

/** `json`: compact JSON (default). `auto`: whichever of JSON and TOON is shorter for this payload. */
export type ToolTextFormat = 'json' | 'auto'

/** Pick the text block encoding; under `auto` the shorter by characters wins, since TOON is larger than JSON for nested shapes. */
export function chooseToolText(serialized: string, format: ToolTextFormat = 'json'): string {
  if (format !== 'auto') return serialized

  let value: unknown
  try {
    value = JSON.parse(serialized)
  } catch {
    return serialized
  }

  // Primitives gain nothing and TOON's root forms only add framing.
  if (value === null || typeof value !== 'object') return serialized

  try {
    const toon = toonEncode(value)
    // TOON renders `{}` as "", and clients reject an empty text block.
    if (toon.trim() === '') return serialized
    return toon.length < serialized.length ? toon : serialized
  } catch {
    return serialized
  }
}
