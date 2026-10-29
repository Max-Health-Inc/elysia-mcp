// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: Apache-2.0

/** Calls dispatch through `app.handle()` so guards, response coercion and audit hooks run; pass the ROOT app. */

import { Value } from '@sinclair/typebox/value'
import type { ToolMetadata, ResourceMetadata } from './types.js'
import { getMergedInputSchema } from './typebox-schema.js'
import { pathToToolName } from './introspect.js'
import { chooseToolText, type ToolTextFormat } from './text-format.js'
import { isRecord } from './guards.js'

/** Per-call execution options. */
export interface ExecuteOptions {
  /** Encoding of the text block the model reads; see {@link chooseToolText}. @default 'json' */
  textFormat?: ToolTextFormat
  /** Renders the payload as a host UI; see {@link ToolView}. */
  view?: ToolView
}

/** What a {@link ToolView} is told about the call it is rendering. */
export interface ToolViewContext {
  toolName: string
  meta: ToolMetadata
}

/**
 * Turn a payload into the UI wire object that replaces `structuredContent`; the text block keeps the data for the model.
 * Such a tool must not advertise a route-derived `outputSchema`. Return undefined to pass the payload through.
 */
export type ToolView = (
  payload: StructuredContent,
  context: ToolViewContext,
) => StructuredContent | undefined

/** Minimal Elysia app shape needed for pipeline dispatch. */
export interface DispatchableApp {
  handle(request: Request): Promise<Response> | Response
}

/** Validate args and execute a tool through the app's pipeline. */
export async function executeTool(
  toolName: string,
  meta: ToolMetadata,
  args: Record<string, unknown>,
  authToken: string | undefined,
  app: DispatchableApp,
  options?: ExecuteOptions,
): Promise<{
  content: { type: 'text'; text: string }[]
  structuredContent?: StructuredContent
  isError?: boolean
}> {
  try {
    const inputSchema = getMergedInputSchema(meta)
    if (inputSchema) {
      const valid = Value.Check(inputSchema, args)
      if (!valid) {
        const errors = [...Value.Errors(inputSchema, args)]
        return {
          content: [{ type: 'text', text: `Validation error: ${JSON.stringify(errors)}` }],
          isError: true,
        }
      }
    }

    const { status, text } = await dispatchThroughPipeline(app, meta.path, meta.method, args, authToken)
    if (status >= 400) {
      return { content: [{ type: 'text', text }], isError: true }
    }
    return successResult(text, options, { toolName, meta })
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error executing ${toolName}: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    }
  }
}

/** A resource read: the text a client receives, plus a view when one rendered. */
export interface ResourceResult {
  text: string
  structuredContent?: StructuredContent
}

/** Execute a GET route through the app's pipeline and return the serialized result. */
export async function executeResource(
  meta: ResourceMetadata,
  pathParams: Record<string, string>,
  authToken: string | undefined,
  app: DispatchableApp,
  options?: ExecuteOptions,
): Promise<string> {
  const { text } = await executeResourceResult(meta, pathParams, authToken, app, options)
  return text
}

/** {@link executeResource} plus the view, rendered from the JSON before a TOON text encoding is chosen. */
export async function executeResourceResult(
  meta: ResourceMetadata,
  pathParams: Record<string, string>,
  authToken: string | undefined,
  app: DispatchableApp,
  options?: ExecuteOptions,
): Promise<ResourceResult> {
  const serialized = await readResource(meta, pathParams, authToken, app)
  const view = applyView(serialized, options?.view, {
    toolName: pathToToolName(meta.path, 'GET'),
    meta,
  })
  const text = chooseToolText(serialized, options?.textFormat)
  return view !== undefined ? { text, structuredContent: view } : { text }
}

async function readResource(
  meta: ResourceMetadata,
  pathParams: Record<string, string>,
  authToken: string | undefined,
  app: DispatchableApp,
): Promise<string> {
  try {
    const { text } = await dispatchThroughPipeline(app, meta.path, 'GET', pathParams, authToken)
    return text
  } catch (err) {
    return JSON.stringify({ error: `Resource read failed: ${err instanceof Error ? err.message : String(err)}` })
  }
}

/** Rebuild the HTTP request (path params interpolated, rest as query for GET or JSON body otherwise) and dispatch it. */
async function dispatchThroughPipeline(
  app: DispatchableApp,
  path: string,
  method: string,
  args: Record<string, unknown>,
  authToken?: string,
): Promise<{ status: number; text: string }> {
  const { url, rest } = buildUrl(path, method, args)
  const isGet = method.toUpperCase() === 'GET'

  const headers = bearerHeaders(authToken)
  const init: RequestInit = { method, headers }
  if (!isGet && Object.keys(rest).length > 0) {
    headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(rest)
  }

  const response = await app.handle(new Request(`http://localhost${url}`, init))
  const text = await response.text()
  return { status: response.status, text }
}

const DOT_SEGMENTS = new Set(['.', '..'])

/** Returns the concrete URL plus the args not consumed as path params. */
function buildUrl(
  path: string,
  method: string,
  args: Record<string, unknown>,
): { url: string; rest: Record<string, unknown> } {
  const pathParams = extractPathParams(path, args)
  let url = path
  for (const [name, value] of Object.entries(pathParams)) {
    if (DOT_SEGMENTS.has(value)) throw new Error(`Path parameter "${name}" cannot be "${value}"`)
    url = url.replace(`:${name}`, encodeURIComponent(value))
  }

  const rest = { ...args }
  for (const key of Object.keys(pathParams)) delete rest[key]

  if (method.toUpperCase() === 'GET' && Object.keys(rest).length > 0) {
    const qs = new URLSearchParams()
    for (const [key, value] of Object.entries(rest)) {
      if (value !== undefined && value !== null) qs.append(key, String(value))
    }
    const query = qs.toString()
    if (query) url += `?${query}`
    return { url, rest: {} }
  }

  return { url, rest }
}


/**
 * Always a text block (spec back-compat; also skips the SDK's SEP-2106 §4.3 auto-append), plus JSON `structuredContent`.
 * Arrays included: the SDK wraps them as `{result}` for 2025-era clients. Structured content comes from the JSON, never the TOON text.
 */
function successResult(
  text: string,
  options: ExecuteOptions | undefined,
  context: ToolViewContext,
): {
  content: { type: 'text'; text: string }[]
  structuredContent?: StructuredContent
} {
  const structured = toStructuredContent(text)
  // Clients reject an empty text block, e.g. after a 204.
  const chosen = chooseToolText(text, options?.textFormat)
  const rendered = chosen.trim() === '' ? '(no content)' : chosen
  const content = [{ type: 'text' as const, text: rendered }]

  const view = applyView(text, options?.view, context)
  if (view !== undefined) return { content, structuredContent: view }

  return structured !== undefined
    ? { content, structuredContent: structured }
    : { content }
}

/** Render a payload through a view; a throwing view yields undefined so a successful call never fails on presentation. */
export function applyView(
  serialized: string,
  view: ToolView | undefined,
  context: ToolViewContext,
): StructuredContent | undefined {
  if (view === undefined) return undefined
  const payload = toStructuredContent(serialized)
  if (payload === undefined) return undefined
  try {
    return view(payload, context)
  } catch {
    return undefined
  }
}

/** JSON object or array accepted as `structuredContent`; primitives add nothing over the text block. */
export type StructuredContent = Record<string, unknown> | unknown[]

function toStructuredContent(text: string): StructuredContent | undefined {
  try {
    const parsed: unknown = JSON.parse(text)
    if (Array.isArray(parsed) || isRecord(parsed)) return parsed
  } catch {
    // Not JSON: the text block is the only representation.
  }
  return undefined
}

function bearerHeaders(authToken?: string): Record<string, string> {
  return authToken ? { Authorization: `Bearer ${authToken}` } : {}
}

/** `/admin/users/:userId` + `{ userId: "123", name: "foo" }` → `{ userId: "123" }` */
function extractPathParams(path: string, args: Record<string, unknown>): Record<string, string> {
  const params: Record<string, string> = {}
  const paramNames = path.match(/:(\w+)/g)
  if (paramNames) {
    for (const param of paramNames) {
      const name = param.slice(1)
      if (args[name] !== undefined) {
        params[name] = String(args[name])
      }
    }
  }
  return params
}

