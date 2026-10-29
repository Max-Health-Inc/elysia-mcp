// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: Apache-2.0

/** Schema-derived prefab UIs for generated tools; prefab is an optional peer and importing this module is the opt-in. */

import {
  PrefabApp,
  autoDetail,
  autoForm,
  autoTable,
  fieldsFromJsonSchema,
  PREFAB_RESOURCE_URI,
  type AutoFormField,
  type Component,
} from '@maxhealth.tech/prefab'
import type { ToolMetadata } from './types.js'
import type { StructuredContent, ToolView, ToolViewContext } from './executor.js'
import { getMergedInputSchema, typeboxToJsonSchema } from './typebox-schema.js'

/** Tool `_meta` pointing an MCP Apps host at the renderer; goes on the tool definition, since hosts resolve `ui://` at list time. */
export function uiToolMeta(resourceUri: string = PREFAB_RESOURCE_URI): { ui: { resourceUri: string } } {
  return { ui: { resourceUri } }
}

/** Verb prefixes `pathToToolName` produces, stripped so a title reads as a noun. */
const TOOL_VERBS = new Set(['create', 'update', 'delete', 'list', 'get', 'read', 'search'])

/** `list_admin_smart-apps` → `Admin smart apps`. */
export function titleFromToolName(toolName: string): string {
  const parts = toolName.split('_').filter(p => p.length > 0)
  const stripped = TOOL_VERBS.has(parts[0] ?? '') ? parts.slice(1) : parts
  const words = stripped.length > 0 ? stripped : parts
  const text = words.join(' ').replace(/-/g, ' ')
  return text.length === 0 ? toolName : text.charAt(0).toUpperCase() + text.slice(1)
}

/** `create_admin_smart-apps` → `Create admin smart apps`. Keeps the verb, which a form needs. */
export function labelFromToolName(toolName: string): string {
  const text = toolName.split('_').join(' ').replace(/-/g, ' ').trim()
  return text.length === 0 ? toolName : text.charAt(0).toUpperCase() + text.slice(1)
}

function verbOf(toolName: string): string | undefined {
  const first = toolName.split('_')[0]
  return first !== undefined && TOOL_VERBS.has(first) ? first : undefined
}

type Row = Record<string, unknown>

function isRow(value: unknown): value is Row {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isRowList(value: unknown): value is Row[] {
  return Array.isArray(value) && value.length > 0 && value.every(isRow)
}

/** Unwrap a list envelope (`{ items: [...], total }`) only when it holds exactly one row array. */
function unwrapList(payload: Row): Row[] | undefined {
  const lists = Object.values(payload).filter(isRowList)
  return lists.length === 1 ? lists[0] : undefined
}

export interface PrefabViewOptions {
  /** Rows kept in a table, so a huge list is not shipped into the iframe. @default 500 */
  maxRows?: number
  /** Per-tool override; return undefined to fall through to the default table or detail card. */
  render?: (payload: StructuredContent, context: ToolViewContext) => Component | PrefabApp | undefined
  /** Called when a payload gets no view, which is otherwise silent. */
  onSkipped?: (context: ToolViewContext) => void
}

/** Default view: a list becomes a table, a record a detail card, anything else no view. */
export function defaultView(
  payload: StructuredContent,
  context: ToolViewContext,
  options?: PrefabViewOptions,
): Component | undefined {
  const title = titleFromToolName(context.toolName)
  const maxRows = options?.maxRows ?? 500

  if (isRowList(payload)) return autoTable(payload.slice(0, maxRows), { title })

  if (isRow(payload)) {
    const list = unwrapList(payload)
    if (list !== undefined) return autoTable(list.slice(0, maxRows), { title })
    if (Object.keys(payload).length > 0) return autoDetail(payload, { title })
  }

  return undefined
}

export interface ToolFormOptions {
  /** Form heading. @default the humanized tool name */
  title?: string
  /** Submit button text. @default the tool's own verb (`Create`, `Update`, …) */
  submitLabel?: string
  /** Argument names to leave out entirely. */
  exclude?: string[]
  /** Pre-filled values by argument name, e.g. the path param that binds a form to one record. */
  values?: Record<string, string | number | boolean | string[]>
}

/**
 * Build the form a tool's input schema describes; submit calls that same tool, path params included.
 * Returns undefined when there is nothing a flat form can ask for.
 */
export function toolForm(
  toolName: string,
  meta: ToolMetadata,
  options?: ToolFormOptions,
): Component | undefined {
  const jsonSchema = typeboxToJsonSchema(getMergedInputSchema(meta))
  if (jsonSchema === undefined) return undefined

  const fields = fieldsFromJsonSchema(jsonSchema, {
    ...(options?.exclude !== undefined && { exclude: options.exclude }),
  })
  if (fields.length === 0) return undefined

  const values = options?.values
  const prefilled: AutoFormField[] = values === undefined
    ? fields
    : fields.map(f => (values[f.name] === undefined ? f : { ...f, default: values[f.name] }))

  const verb = verbOf(toolName)
  return autoForm(prefilled, toolName, {
    title: options?.title ?? labelFromToolName(toolName),
    submitLabel: options?.submitLabel ?? (verb === undefined ? 'Submit' : verb.charAt(0).toUpperCase() + verb.slice(1)),
  })
}

/** A {@link ToolView} rendering payloads as prefab UIs; declined payloads keep their JSON `structuredContent`. */
export function prefabView(options?: PrefabViewOptions): ToolView {
  return (payload, context) => {
    const built = options?.render?.(payload, context) ?? defaultView(payload, context, options)
    if (built === undefined) {
      options?.onSkipped?.(context)
      return undefined
    }
    const app = built instanceof PrefabApp
      ? built
      : new PrefabApp({ title: titleFromToolName(context.toolName), view: built })
    const wire: StructuredContent = app.toJSON()
    return wire
  }
}
