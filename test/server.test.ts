import { describe, it, expect } from 'bun:test'
import { Elysia, t } from 'elysia'
import { McpServer, createMcpHandler, type McpHttpHandler } from '@modelcontextprotocol/server'
import { mcp } from '../src/route-option'
import { toMcpServer, registerRouteTools, registerRouteResources, bearerToken } from '../src/server'

const Role = t.Object({ name: t.String() })

function createApp() {
  const roles = new Map<string, { name: string }>([['admin', { name: 'admin' }]])
  return new Elysia()
    .use(mcp())
    .get('/admin/roles', () => [...roles.values()], {
      response: { 200: t.Array(Role) },
      detail: { summary: 'List roles', description: 'Every realm role.' },
    })
    .get('/admin/roles/:roleName', ({ params }) => roles.get(params.roleName) ?? { name: '' }, {
      params: t.Object({ roleName: t.String() }),
    })
    .post('/admin/roles', ({ body, headers, set }) => {
      if (headers.authorization !== 'Bearer good') {
        set.status = 401
        return { error: 'unauthorized' }
      }
      roles.set(body.name, body)
      return body
    }, { body: Role, response: { 200: Role, 401: t.Object({ error: t.String() }) } })
    .delete('/admin/roles/:roleName', ({ params }) => {
      roles.delete(params.roleName)
      return { deleted: params.roleName }
    }, { params: t.Object({ roleName: t.String() }), mcp: false })
    .get('/ping', () => ({ pong: true }), { mcp: { public: true } })
}

interface RpcReply {
  result?: Record<string, unknown>
  error?: { code: number; message: string }
}

let nextId = 1
async function rpc(handler: McpHttpHandler, method: string, params: Record<string, unknown> = {}, token?: string): Promise<RpcReply> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': '2025-11-25',
  }
  if (token) headers.authorization = `Bearer ${token}`
  const response = await handler.fetch(new Request('http://localhost/mcp', {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
  }))
  const text = await response.text()
  const json = text.startsWith('{') ? text : text.split('\n').find((line) => line.startsWith('data: '))?.slice(6) ?? '{}'
  return JSON.parse(json)
}

function serve(app: ReturnType<typeof createApp>, options: Parameters<typeof toMcpServer>[1] = {}): McpHttpHandler {
  return createMcpHandler(({ requestInfo }) => toMcpServer(app, { ...options, authToken: bearerToken(requestInfo) }))
}

function toolNames(reply: RpcReply): string[] {
  const tools = reply.result?.tools
  return Array.isArray(tools) ? tools.map((tool: { name: string }) => tool.name).sort() : []
}

describe('toMcpServer over createMcpHandler', () => {
  it('lists the selected routes as tools', async () => {
    const reply = await rpc(serve(createApp()), 'tools/list')
    expect(toolNames(reply)).toEqual([
      'create_admin_roles',
      'get_admin_roles',
      'get_admin_roles_roleName',
      'get_ping',
    ])
  })

  it('advertises title, description, annotations and output schema from the route', async () => {
    const reply = await rpc(serve(createApp()), 'tools/list')
    const tools = (reply.result?.tools ?? []) as Array<Record<string, unknown>>
    const list = tools.find((tool) => tool.name === 'get_admin_roles')
    expect(list?.title).toBe('List roles')
    expect(list?.description).toBe('Every realm role.')
    expect(list?.annotations).toMatchObject({ readOnlyHint: true })
    expect(list?.outputSchema).toBeDefined()
  })

  it('dispatches a call through the app with the caller token', async () => {
    const handler = serve(createApp())
    const denied = await rpc(handler, 'tools/call', { name: 'create_admin_roles', arguments: { name: 'auditor' } }, 'bad')
    expect(denied.result?.isError).toBe(true)

    const created = await rpc(handler, 'tools/call', { name: 'create_admin_roles', arguments: { name: 'auditor' } }, 'good')
    expect(created.result?.isError).toBeUndefined()
    expect(created.result?.structuredContent).toEqual({ name: 'auditor' })
  })

  it('filters tools per request', async () => {
    const handler = serve(createApp(), { filter: (_name, meta) => meta.public === true })
    expect(toolNames(await rpc(handler, 'tools/list'))).toEqual(['get_ping'])
  })

  it('registers GET routes as resources when asked', async () => {
    const handler = serve(createApp(), { resources: { scheme: 'roles' } })
    const listed = await rpc(handler, 'resources/list')
    const uris = ((listed.result?.resources ?? []) as Array<{ uri: string }>).map((r) => r.uri).sort()
    expect(uris).toEqual(['roles://admin/roles', 'roles://ping'])

    const templates = await rpc(handler, 'resources/templates/list')
    const templateUris = ((templates.result?.resourceTemplates ?? []) as Array<{ uriTemplate: string }>).map((r) => r.uriTemplate)
    expect(templateUris).toEqual(['roles://admin/roles/{roleName}'])

    const read = await rpc(handler, 'resources/read', { uri: 'roles://admin/roles/admin' })
    const contents = (read.result?.contents ?? []) as Array<{ text: string }>
    expect(JSON.parse(contents[0]?.text ?? '{}')).toEqual({ name: 'admin' })
  })
})

describe('registerRouteTools', () => {
  it('returns the names it registered', () => {
    const server = new McpServer({ name: 't', version: '0.0.0' })
    const names = registerRouteTools(server, createApp(), { prefixes: [] })
    expect(names).toEqual(['get_ping'])
  })

  it('does not advertise an output schema when a view replaces structuredContent', async () => {
    const handler = serve(createApp(), { view: (payload) => payload })
    const reply = await rpc(handler, 'tools/list')
    const tools = (reply.result?.tools ?? []) as Array<Record<string, unknown>>
    expect(tools.every((tool) => tool.outputSchema === undefined)).toBe(true)
  })

  it('attaches _meta to every tool', async () => {
    const handler = serve(createApp(), { toolMeta: { ui: { resourceUri: 'ui://x' } } })
    const reply = await rpc(handler, 'tools/list')
    const tools = (reply.result?.tools ?? []) as Array<Record<string, unknown>>
    expect(tools.every((tool) => JSON.stringify(tool._meta).includes('ui://x'))).toBe(true)
  })
})

describe('registerRouteResources', () => {
  it('returns the names it registered', () => {
    const server = new McpServer({ name: 't', version: '0.0.0' })
    expect(registerRouteResources(server, createApp(), { prefixes: [] })).toEqual(['ping'])
  })
})

describe('bearerToken', () => {
  it('reads a bearer token and ignores other schemes', () => {
    expect(bearerToken(new Request('http://x', { headers: { authorization: 'Bearer abc' } }))).toBe('abc')
    expect(bearerToken(new Request('http://x', { headers: { authorization: 'Basic abc' } }))).toBeUndefined()
    expect(bearerToken(undefined)).toBeUndefined()
  })
})
