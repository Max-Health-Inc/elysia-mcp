// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * @maxhealth.tech/elysia-mcp - Route Introspection
 *
 * Extracts route metadata from an Elysia app instance by reading its internal
 * route table. Produces tool and resource metadata for MCP registration.
 */

import type { TSchema } from '@sinclair/typebox'
import type { ToolMetadata, ResourceMetadata, ToolAnnotations } from './types.js'
import { isRecord, isSchema, nonEmptyText } from './guards.js'
import { readMcpOption, routeConfig, isRouteSelected, type McpRouteConfig, type McpRouteOption } from './route-option.js'

// ── Configuration ────────────────────────────────────────────────────────────

export interface IntrospectOptions {
  /**
   * Route prefixes to include. Only routes starting with one of these
   * prefixes are extracted.
   * @default ['/admin/', '/api/']
   */
  prefixes?: string[]

  /**
   * Custom tool name generator.
   * @default pathToToolName
   */
  toolNameGenerator?: (path: string, method: string) => string

  /**
   * Custom resource name generator.
   * @default pathToResourceName
   */
  resourceNameGenerator?: (path: string) => string
}

// ── Response schema ──────────────────────────────────────────────────────────

/** Preferred success statuses, in the order a route is most likely to declare them. */
const SUCCESS_STATUSES = ['200', '201', '202']

/**
 * Pull the success-response schema out of a route's `response` declaration.
 *
 * Elysia accepts either a bare schema or a status-keyed map
 * (`{ 200: t.Array(Role), ...CommonErrorResponses }`). Only the success entry
 * describes what a successful tool call returns; the error entries describe
 * bodies that never reach `structuredContent`, because a non-2xx dispatch is
 * returned as `isError` text instead.
 */
export function extractResponseSchema(response: unknown): TSchema | undefined {
  if (!isSchema(response)) return undefined
  const entries = response
  const keys = Object.keys(entries)
  if (keys.length === 0) return undefined

  // A schema is itself an object, so the two shapes are told apart by their
  // keys: a status map is keyed entirely by status codes, a schema never is.
  if (!keys.every((k) => /^\d{3}$/.test(k))) return response

  for (const status of SUCCESS_STATUSES) {
    const hit = entries[status]
    if (isSchema(hit)) return hit
  }
  // Any other 2xx (204 carries no body worth advertising, so it is not sought
  // above, but a route using an unusual success code should still be covered).
  for (const key of keys) {
    if (key.startsWith('2') && key !== '204') {
      const hit = entries[key]
      if (isSchema(hit)) return hit
    }
  }
  return undefined
}

// ── Route extraction ─────────────────────────────────────────────────────────

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

/**
 * Derive MCP tool behavioural hints from the HTTP method, mapping REST
 * semantics onto the spec's annotation flags. These are advisory hints for
 * clients (e.g. to confirm before a destructive call), not a security control.
 *
 * - GET     → read-only + idempotent
 * - DELETE  → destructive + idempotent (deleting again yields the same state)
 * - PUT     → idempotent full-replace; not data-destroying
 * - PATCH   → partial update; not guaranteed idempotent
 * - POST    → create; additive, not idempotent, not destructive
 *
 * `openWorldHint` is false for every route: these tools act on the app's own
 * admin surface (a closed domain), not an open/external world.
 */
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

/**
 * Extract GET routes from an Elysia app as MCP resource metadata.
 * Static paths become fixed-URI resources; parameterized paths become URI templates.
 */
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

// ── Naming helpers ───────────────────────────────────────────────────────────

/**
 * Longest tool name a client will accept.
 *
 * Tool names are constrained to `^[a-zA-Z0-9_-]{1,64}$`. A name over the cap is not
 * truncated by the client — the whole tool is REJECTED, and silently as far as the
 * server is concerned. Deep admin paths cross 64 easily: three of this surface's
 * routes produced 66- and 67-character names and were dropped from every session,
 * with nothing in the server's own tool listing to show for it.
 */
export const MAX_TOOL_NAME_LENGTH = 64

const METHOD_PREFIXES: Record<string, string> = {
  GET: 'get',
  POST: 'create',
  PUT: 'update',
  PATCH: 'update',
  DELETE: 'delete',
}

/** A short, stable digest — enough to separate names that would otherwise coincide. */
function digest(input: string): string {
  // FNV-1a. No crypto import for a disambiguator, and it must stay identical across
  // runtimes: a tool name that changes between deploys breaks saved client prompts.
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(36).padStart(7, '0').slice(0, 7)
}

/** Cut a name to the cap, keeping a digest of the original so it stays unique. */
function truncateWithDigest(name: string): string {
  const suffix = `_${digest(name)}`
  return name.slice(0, MAX_TOOL_NAME_LENGTH - suffix.length) + suffix
}

/**
 * Convert route path and method to a tool name.
 *
 * Examples:
 * - POST /admin/users -> create_admin_users
 * - PUT /admin/users/:id -> update_admin_users_id
 * - DELETE /admin/roles/:roleName -> delete_admin_roles_roleName
 * - GET /admin/branding -> get_admin_branding
 *
 * Over {@link MAX_TOOL_NAME_LENGTH}, path PARAMETERS are dropped first:
 * - DELETE /admin/healthcare-users/:userId/client-roles/:clientId/:roleName
 *     -> delete_admin_healthcare-users_client-roles
 * They are the least informative part of a name — every one of them is already an
 * argument in the tool's input schema, described there — so shedding them costs a
 * reader nothing while keeping the segments that say what the tool acts on. Only if
 * that still does not fit is the name cut and digested.
 *
 * Names at or under the cap are returned exactly as before, so shortening can never
 * rename a tool that was already being served.
 */
export function pathToToolName(path: string, method: string): string {
  const prefix = METHOD_PREFIXES[method.toUpperCase()] ?? method.toLowerCase()

  // Verbatim original construction, empty segments included. Several routes are
  // declared with a trailing slash, so their names legitimately end in `_`
  // (`get_admin_profile_`); normalising that away here would rename 30 tools that
  // clients call today, to fix 3 they cannot see.
  const full = `${prefix}_${path.replace(/^\//, '').replace(/\//g, '_').replace(/:/g, '')}`
  if (full.length <= MAX_TOOL_NAME_LENGTH) return full

  const kept = path.split('/').filter((s) => s.length > 0 && !s.startsWith(':'))
  const shortened = `${prefix}_${kept.join('_')}`
  if (kept.length > 0 && shortened.length <= MAX_TOOL_NAME_LENGTH) return shortened

  return truncateWithDigest(full)
}

/**
 * A name not already taken, disambiguated by digesting the route it came from.
 *
 * Dropping parameters can make two routes agree on a name, and the registry is a Map
 * keyed by name: without this the second route would overwrite the first and one tool
 * would vanish with no error anywhere.
 */
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

/**
 * Convert a GET route path to a human-readable resource name.
 *
 * Examples:
 * - /admin/branding -> admin_branding
 * - /admin/roles/:roleName -> admin_roles_by_roleName
 */
export function pathToResourceName(path: string): string {
  let name = path.replace(/^\//, '')
  name = name.replace(/:(\w+)/g, 'by_$1')
  name = name.replace(/\//g, '_')
  name = name.replace(/-/g, '_')
  return name
}

/**
 * Convert an Elysia route path to an MCP resource URI.
 *
 * Static: scheme://admin/branding
 * Parameterized: scheme://admin/roles/{roleName} (RFC 6570 URI template)
 */
export function pathToResourceUri(path: string, scheme = 'app'): string {
  const uriPath = path.replace(/:(\w+)/g, '{$1}')
  return `${scheme}:/${uriPath}`
}
