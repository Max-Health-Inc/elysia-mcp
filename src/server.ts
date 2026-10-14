// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: Apache-2.0

import { McpServer, ResourceTemplate } from '@modelcontextprotocol/server'
import { extractRouteTools, extractRouteResources, describeTool, describeResource, pathToResourceUri, type IntrospectOptions } from './introspect.js'
import { executeTool, executeResource, type DispatchableApp, type ExecuteOptions } from './executor.js'
import { getMergedInputSchema, typeboxToSchema, typeboxToOutputSchema } from './typebox-schema.js'
import { isArgs } from './guards.js'
import type { ToolMetadata, ResourceMetadata } from './types.js'

export interface RouteToolsOptions extends IntrospectOptions, ExecuteOptions {
  authToken?: string
  tools?: ReadonlyMap<string, ToolMetadata>
  filter?: (toolName: string, meta: ToolMetadata) => boolean
  toolMeta?: Record<string, unknown>
}

export interface RouteResourcesOptions extends IntrospectOptions {
  authToken?: string
  resources?: ReadonlyMap<string, ResourceMetadata>
  filter?: (resourceName: string, meta: ResourceMetadata) => boolean
  scheme?: string
}

export interface ToMcpServerOptions extends RouteToolsOptions {
  serverInfo?: { name: string; version: string }
  resources?: boolean | Pick<RouteResourcesOptions, 'resources' | 'filter' | 'scheme'>
}

const JSON_MIME = 'application/json'

export function registerRouteTools(server: McpServer, app: DispatchableApp, options: RouteToolsOptions = {}): string[] {
  const tools = options.tools ?? extractRouteTools(app, options)
  const execute: ExecuteOptions = { textFormat: options.textFormat, view: options.view }
  const registered: string[] = []

  for (const [name, meta] of tools) {
    if (options.filter && !options.filter(name, meta)) continue

    const input = getMergedInputSchema(meta)
    const inputSchema = input ? typeboxToSchema(input) : undefined
    const outputSchema = options.view ? undefined : typeboxToOutputSchema(meta.responseSchema)
    const config = {
      description: describeTool(name, meta),
      annotations: meta.annotations,
      ...(meta.title ? { title: meta.title } : {}),
      ...(outputSchema ? { outputSchema } : {}),
      ...(options.toolMeta ? { _meta: options.toolMeta } : {}),
    }
    const run = (args: unknown) =>
      executeTool(name, meta, isArgs(args) ? args : {}, options.authToken, app, execute)

    if (inputSchema) server.registerTool(name, { ...config, inputSchema }, run)
    else server.registerTool(name, config, () => run({}))
    registered.push(name)
  }

  return registered
}

export function registerRouteResources(server: McpServer, app: DispatchableApp, options: RouteResourcesOptions = {}): string[] {
  const resources = options.resources ?? extractRouteResources(app, options)
  const registered: string[] = []

  for (const [name, meta] of resources) {
    if (options.filter && !options.filter(name, meta)) continue

    const uri = pathToResourceUri(meta.path, options.scheme)
    const metadata = {
      mimeType: JSON_MIME,
      description: describeResource(name, meta),
      ...(meta.title ? { title: meta.title } : {}),
    }
    const read = (params: Record<string, string>) => executeResource(meta, params, options.authToken, app)

    if (meta.pathParams.length === 0) {
      server.registerResource(name, uri, metadata, async () => ({
        contents: [{ uri, mimeType: JSON_MIME, text: await read({}) }],
      }))
    } else {
      server.registerResource(name, new ResourceTemplate(uri, { list: undefined }), metadata, async (requestUri, variables) => {
        const params: Record<string, string> = {}
        for (const param of meta.pathParams) {
          const value = variables[param]
          if (value !== undefined) params[param] = Array.isArray(value) ? value.join(',') : String(value)
        }
        return { contents: [{ uri: requestUri.href, mimeType: JSON_MIME, text: await read(params) }] }
      })
    }
    registered.push(name)
  }

  return registered
}

export function toMcpServer(app: DispatchableApp, options: ToMcpServerOptions = {}): McpServer {
  const server = new McpServer(options.serverInfo ?? { name: 'elysia-mcp', version: '1.0.0' })
  registerRouteTools(server, app, options)
  if (options.resources) {
    registerRouteResources(server, app, {
      prefixes: options.prefixes,
      resourceNameGenerator: options.resourceNameGenerator,
      authToken: options.authToken,
      ...(typeof options.resources === 'object' ? options.resources : {}),
    })
  }
  return server
}

export function bearerToken(request: Request | undefined): string | undefined {
  const match = request?.headers.get('authorization')?.match(/^Bearer\s+(\S+)\s*$/i)
  return match?.[1]
}
