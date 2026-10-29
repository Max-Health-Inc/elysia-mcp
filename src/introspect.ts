// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: Apache-2.0

/** Reads an Elysia app's route table into MCP tool and resource metadata. */

import type { TSchema } from '@sinclair/typebox'
import type { ToolMetadata, ResourceMetadata, ToolAnnotations } from './types.js'
import { isRecord, isSchema, nonEmptyText } from './guards.js'
import { readMcpOption, routeConfig, isRouteSelected, type McpRouteConfig, type McpRouteOption } from './route-option.js'

export interface IntrospectOptions {
  /** Route prefixes to include. @default ['/admin/', '/api/'] */
  prefixes?: string[]

  /** @default pathToToolName */
  toolNameGenerator?: (path: string, method: string) => string

  /** @default pathToResourceName */
  resourceNameGenerator?: (path: string) => string
}

const SUCCESS_STATUSES = ['200', '201', '202']

/** Success-response schema from a bare schema or a status-keyed map; error entries never reach `structuredContent`. */
export function extractResponseSchema(response: unknown): TSchema | undefined {
  if (!isSchema(response)) return undefined
  const entries = response
  const keys = Object.keys(entries)
  if (keys.length === 0) return undefined

  // A status map is keyed entirely by status codes, a schema never is.
  if (!keys.every((k) => /^\d{3}$/.test(k))) return response

  for (const status of SUCCESS_STATUSES) {
    const hit = entries[status]
    if (isSchema(hit)) return hit
  }
  // Any other 2xx except the bodyless 204.
  for (const key of keys) {
    if (key.startsWith('2') && key !== '204') {
      const hit = entries[key]
      if (isSchema(hit)) return hit
    }
  }
  return undefined
}

const DEFAULT_PREFIXES = ['/admin/', '/api/']
const UNCALLABLE_METHODS = new Set(['HEAD', 'OPTIONS', 'ALL'])

interface RouteRecord {
  path: string
  method: string
  handler: unknown
  body?: TSchema
  params?: TSchema
  query?: TSchema
  response: unknown
  option: McpRouteOption | undefined
  config: McpRouteConfig
  title?: string
  description?: string
  operationId?: string
  hidden: boolean
  public: boolean
}

function readRoute(route: unknown): RouteRecord | undefined {
  if (!isRecord(route)) return undefined
  const { path, method, handler } = route
  if (typeof path !== 'string' || typeof method !== 'string') return undefined

  const hooks = isRecord(route.hooks) ? route.hooks : {}
  const legacy = isRecord(route.schema) ? route.schema : {}
  const detail = isRecord(hooks.detail) ? hooks.detail : {}
  const meta = isRecord(route.meta) ? route.meta : {}
  const schema = (key: string) => {
    const value = hooks[key] ?? legacy[key]
    return isSchema(value) ? value : undefined
  }
  const option = readMcpOption(hooks.mcp)
  const config = routeConfig(option)
  const summary = nonEmptyText(detail.summary)

  return {
    path,
    method,
    handler,
    body: schema('body'),
    params: schema('params'),
    query: schema('query'),
    response: hooks.response ?? legacy.response,
    option,
    config,
    title: config.title ?? summary,
    description: config.description ?? nonEmptyText(detail.description) ?? summary,
    operationId: nonEmptyText(detail.operationId),
    hidden: detail.hide === true,
    public: config.public ?? meta.public === true,
  }
}

function selectedRoutes(app: unknown, prefixes: readonly string[]): RouteRecord[] {
  const routes = isRecord(app) && Array.isArray(app.routes) ? app.routes : []
  return routes
    .map(readRoute)
    .filter((route): route is RouteRecord =>
      route !== undefined &&
      !(route.hidden && route.option === undefined) &&
      isRouteSelected(route.option, route.path, prefixes))
}

function fitToolName(name: string): string {
  return name.length <= MAX_TOOL_NAME_LENGTH ? name : truncateWithDigest(name)
}

export function extractRouteTools(app: unknown, options?: IntrospectOptions): Map<string, ToolMetadata> {
  const tools = new Map<string, ToolMetadata>()
  const nameGen = options?.toolNameGenerator ?? pathToToolName

  for (const route of selectedRoutes(app, options?.prefixes ?? DEFAULT_PREFIXES)) {
    const { path, method } = route
    if (UNCALLABLE_METHODS.has(method)) continue

    const isGet = method === 'GET'
    const declared = route.config.name ?? route.operationId
    const candidate = declared ? fitToolName(declared) : nameGen(path, method)
    const toolName = uniqueToolName(candidate, path, method, new Set(tools.keys()))

    tools.set(toolName, {
      path,
      method,
      handler: route.handler,
      schema: isGet ? route.query : route.body,
      paramsSchema: route.params,
      responseSchema: extractResponseSchema(route.response),
      title: route.title,
      description: route.description,
      public: route.public,
      readOnly: isGet,
      annotations: annotationsForMethod(method),
    })
  }

  return tools
}

/** MCP annotations from REST semantics; `openWorldHint` is false since tools act on the app's own closed domain. */
export function annotationsForMethod(method: string): ToolAnnotations {
  switch (method.toUpperCase()) {
    case 'GET':
      return { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
    case 'DELETE':
      return { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
    case 'PUT':
      return { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    case 'PATCH':
      return { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    case 'POST':
    default:
      return { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }
}

/** Extract GET routes as MCP resources; parameterized paths become URI templates. */
export function extractRouteResources(app: unknown, options?: IntrospectOptions): Map<string, ResourceMetadata> {
  const resources = new Map<string, ResourceMetadata>()
  const nameGen = options?.resourceNameGenerator ?? pathToResourceName

  for (const route of selectedRoutes(app, options?.prefixes ?? DEFAULT_PREFIXES)) {
    const { path, method } = route
    if (method !== 'GET') continue

    const paramMatches = path.match(/:(\w+)/g)
    const pathParams = paramMatches ? paramMatches.map(p => p.slice(1)) : []

    resources.set(nameGen(path), {
      path,
      method,
      handler: route.handler,
      paramsSchema: route.params,
      title: route.title,
      description: route.description,
      public: route.public,
      pathParams,
    })
  }

  return resources
}

/** Clients silently reject, not truncate, a tool named outside `^[a-zA-Z0-9_-]{1,64}$`. */
export const MAX_TOOL_NAME_LENGTH = 64

const METHOD_PREFIXES: Record<string, string> = {
  GET: 'get',
  POST: 'create',
  PUT: 'update',
  PATCH: 'update',
  DELETE: 'delete',
}

function digest(input: string): string {
  // FNV-1a: must stay identical across runtimes, or tool names change between deploys.
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(36).padStart(7, '0').slice(0, 7)
}

function truncateWithDigest(name: string): string {
  const suffix = `_${digest(name)}`
  return name.slice(0, MAX_TOOL_NAME_LENGTH - suffix.length) + suffix
}

/**
 * `PUT /admin/users/:id` → `update_admin_users_id`. Over {@link MAX_TOOL_NAME_LENGTH}, path params are dropped first,
 * then the name is cut and digested. Names under the cap never change.
 */
export function pathToToolName(path: string, method: string): string {
  const prefix = METHOD_PREFIXES[method.toUpperCase()] ?? method.toLowerCase()

  // Trailing `_` from trailing-slash routes is kept: normalising would rename live tools.
  const full = `${prefix}_${path.replace(/^\//, '').replace(/\//g, '_').replace(/:/g, '')}`
  if (full.length <= MAX_TOOL_NAME_LENGTH) return full

  const kept = path.split('/').filter((s) => s.length > 0 && !s.startsWith(':'))
  const shortened = `${prefix}_${kept.join('_')}`
  if (kept.length > 0 && shortened.length <= MAX_TOOL_NAME_LENGTH) return shortened

  return truncateWithDigest(full)
}

/** Disambiguate a taken name with a route digest, so a collision cannot silently overwrite a tool. */
export function uniqueToolName(candidate: string, path: string, method: string, taken: ReadonlySet<string>): string {
  if (!taken.has(candidate)) return candidate

  const suffix = `_${digest(`${method} ${path}`)}`
  const base = candidate.slice(0, MAX_TOOL_NAME_LENGTH - suffix.length)
  return `${base}${suffix}`
}

const ACTION_PHRASES: Record<string, string> = {
  get: 'Get',
  create: 'Create a new',
  update: 'Update an existing',
  delete: 'Delete an existing',
}

function audience(meta: { public?: boolean }): string {
  return meta.public ? '(Public)' : '(Admin only)'
}

export function describeTool(toolName: string, meta: Pick<ToolMetadata, 'public' | 'description'>): string {
  if (meta.description) return meta.description
  const [action, ...resource] = toolName.split('_')
  return `${ACTION_PHRASES[action] ?? action} ${resource.join(' ')}. ${audience(meta)}`
}

export function describeResource(resourceName: string, meta: Pick<ResourceMetadata, 'public' | 'description'>): string {
  return meta.description ?? `Read ${resourceName.split('_').join(' ')}. ${audience(meta)}`
}

/** `/admin/roles/:roleName` → `admin_roles_by_roleName` */
export function pathToResourceName(path: string): string {
  let name = path.replace(/^\//, '')
  name = name.replace(/:(\w+)/g, 'by_$1')
  name = name.replace(/\//g, '_')
  name = name.replace(/-/g, '_')
  return name
}

/** `/admin/roles/:roleName` → `app://admin/roles/{roleName}` (RFC 6570 template) */
export function pathToResourceUri(path: string, scheme = 'app'): string {
  const uriPath = path.replace(/:(\w+)/g, '{$1}')
  return `${scheme}:/${uriPath}`
}
