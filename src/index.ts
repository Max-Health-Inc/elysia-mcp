// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * @maxhealth.tech/elysia-mcp
 *
 * Derives MCP tools and resources from an Elysia app's route table, and executes
 * them back through that app. The HTTP edge is not here: hosts serve MCP with
 * @maxhealth.tech/mcp-http, which tracks the protocol through the SDK.
 *
 * @example
 * ```ts
 * const tools = extractRouteTools(app, { prefixes: ['/admin/'] })
 * const meta = tools.get('create_admin_users')
 * await executeTool('create_admin_users', meta, args, token, app)
 * ```
 */

// ── Re-exports ───────────────────────────────────────────────────────────────

export type { ToolMetadata, ToolAnnotations, ResourceMetadata } from './types.js'

export {
  extractRouteTools,
  extractRouteResources,
  extractResponseSchema,
  annotationsForMethod,
  pathToToolName,
  uniqueToolName,
  describeTool,
  describeResource,
  MAX_TOOL_NAME_LENGTH,
  pathToResourceName,
  pathToResourceUri,
} from './introspect.js'

export type { IntrospectOptions } from './introspect.js'

export {
  typeboxToSchema,
  typeboxToOutputSchema,
  typeboxToJsonSchema,
  getMergedInputSchema,
} from './typebox-schema.js'

export {
  executeTool,
  executeResource,
  executeResourceResult,
  applyView,
  type ExecuteOptions,
  type ResourceResult,
  type StructuredContent,
  type ToolView,
  type ToolViewContext,
  type DispatchableApp,
} from './executor.js'

export { chooseToolText, type ToolTextFormat } from './text-format.js'

export { mcp, type McpRouteConfig, type McpRouteOption } from './route-option.js'

export {
  toMcpServer,
  registerRouteTools,
  registerRouteResources,
  bearerToken,
  type ToMcpServerOptions,
  type RouteToolsOptions,
  type RouteResourcesOptions,
} from './server.js'

export { MCP_REQUEST_HEADERS, MCP_EXPOSED_RESPONSE_HEADERS } from './headers.js'
