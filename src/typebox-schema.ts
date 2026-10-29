// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: Apache-2.0

/** TypeBox schemas are JSON Schema plus Symbol metadata, so conversion is a JSON roundtrip handed to the SDK. */

import { fromJsonSchema, type StandardSchemaWithJSON } from '@modelcontextprotocol/server'
import type { TSchema, TProperties } from '@sinclair/typebox'
import { isRecord, isSchema, stringList } from './guards.js'
import { Type } from '@sinclair/typebox'
import type { ToolMetadata } from './types.js'

/**
 * Elysia's coercion-hint formats (`t.Integer()` → `{ type: 'string', format: 'integer' }`); Ajv ignores them but logs
 * a warning per occurrence, so dropping them is lossless. `date` and `date-time` are real formats and stay.
 */
const ELYSIA_COERCION_FORMATS = new Set(['numeric', 'integer', 'boolean', 'ArrayString'])

/** Drop coercion-hint formats in place, only on string branches. */
function stripCoercionFormats(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) stripCoercionFormats(item)
    return
  }
  if (!isRecord(node)) return
  const record = node
  if (
    record.type === 'string' &&
    typeof record.format === 'string' &&
    ELYSIA_COERCION_FORMATS.has(record.format)
  ) {
    delete record.format
  }
  for (const value of Object.values(record)) stripCoercionFormats(value)
}

/** JSON roundtrip to strip TypeBox's Symbol metadata, then de-noise the result. */
function toPlainJsonSchema(schema: unknown): Record<string, unknown> {
  const jsonSchema: unknown = JSON.parse(JSON.stringify(schema))
  if (!isRecord(jsonSchema)) throw new TypeError('A JSON Schema must be an object')
  stripCoercionFormats(jsonSchema)
  return jsonSchema
}

/** Convert a TypeBox schema to plain JSON Schema, or undefined when unreadable. */
export function typeboxToJsonSchema(schema: unknown): Record<string, unknown> | undefined {
  if (schema === null || schema === undefined) return undefined
  try {
    return toPlainJsonSchema(schema)
  } catch {
    return undefined
  }
}

/** Convert a TypeBox schema to the `registerTool` input Standard Schema, or undefined unless it is a readable object type. */
export function typeboxToSchema(schema: unknown): StandardSchemaWithJSON | undefined {
  try {
    const jsonSchema = toPlainJsonSchema(schema)
    if (jsonSchema.type !== 'object' || !jsonSchema.properties) return undefined
    return fromJsonSchema(jsonSchema)
  } catch {
    return undefined
  }
}

/**
 * Convert a TypeBox schema to a `registerTool` `outputSchema`, or undefined when unreadable.
 * Array roots are allowed: the SDK wraps them as `{result}` for 2025-era clients.
 */
export function typeboxToOutputSchema(schema: unknown): StandardSchemaWithJSON | undefined {
  if (schema === null || schema === undefined) return undefined
  try {
    const jsonSchema = toPlainJsonSchema(schema)
    // Nothing to validate against; advertising it would invite false rejections.
    if (!jsonSchema.type && !jsonSchema.anyOf && !jsonSchema.oneOf && !jsonSchema.allOf && !jsonSchema.$ref) {
      return undefined
    }
    return fromJsonSchema(jsonSchema)
  } catch {
    return undefined
  }
}

function propertiesOf(schema: TSchema): TProperties {
  const properties: unknown = schema.properties
  if (!isRecord(properties)) return {}
  return Object.fromEntries(Object.entries(properties).filter((entry): entry is [string, TSchema] => isSchema(entry[1])))
}

/** Merge body and path-params schemas into one flat input object. */
export function getMergedInputSchema(meta: ToolMetadata): TSchema | undefined {
  const { schema: bodySchema, paramsSchema } = meta
  if (!bodySchema && !paramsSchema) return undefined
  if (!paramsSchema) return bodySchema
  if (!bodySchema) return paramsSchema

  const bodyProps = propertiesOf(bodySchema)
  const paramsProps = propertiesOf(paramsSchema)

  const bodyRequired = stringList(bodySchema.required)
  const paramsRequired = stringList(paramsSchema.required)

  // Path params win on a name clash
  const mergedProps: TProperties = { ...bodyProps, ...paramsProps }

  const merged = Type.Object(mergedProps, { additionalProperties: false })

  // TypeBox rederives `required`, losing one side's list; use the union instead.
  const allRequired = [...new Set([...paramsRequired, ...bodyRequired])]
  const { required: _rederived, ...withoutRequired } = merged

  return allRequired.length > 0
    ? { ...withoutRequired, required: allRequired }
    : withoutRequired
}
