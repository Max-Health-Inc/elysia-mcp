import { describe, it, expect } from 'bun:test'
import { Elysia, t } from 'elysia'
import { extractRouteTools, extractRouteResources, describeTool, describeResource, MAX_TOOL_NAME_LENGTH } from '../src/introspect'
import { mcp } from '../src/route-option'

function createApp() {
  return new Elysia()
    .use(mcp())
    .get('/admin/roles', () => [], {
      detail: { summary: 'List roles', description: 'Every realm role, with its composites.' },
    })
    .post('/admin/roles', ({ body }) => body, {
      body: t.Object({ name: t.String() }),
      mcp: { name: 'make_role', description: 'Create a realm role.' },
    })
    .delete('/admin/roles/:roleName', () => ({}), { mcp: false })
    .get('/health', () => 'ok', { mcp: { public: true, title: 'Health' } })
    .get('/internal/metrics', () => ({}))
    .post('/webhooks/stripe', () => ({}), { mcp: true })
}

describe('mcp route option', () => {
  it('excludes a prefixed route marked mcp: false', () => {
    const tools = extractRouteTools(createApp(), { prefixes: ['/admin/'] })
    expect(tools.has('delete_admin_roles_roleName')).toBe(false)
  })

  it('includes a route outside the prefixes when it is marked', () => {
    const tools = extractRouteTools(createApp(), { prefixes: ['/admin/'] })
    expect(tools.has('get_health')).toBe(true)
    expect(tools.has('create_webhooks_stripe')).toBe(true)
    expect(tools.has('get_internal_metrics')).toBe(false)
  })

  it('selects only marked routes when prefixes is empty', () => {
    const tools = extractRouteTools(createApp(), { prefixes: [] })
    expect([...tools.keys()].sort()).toEqual(['create_webhooks_stripe', 'get_health', 'make_role'])
  })

  it('uses the configured name instead of the generated one', () => {
    const tools = extractRouteTools(createApp(), { prefixes: ['/admin/'] })
    expect(tools.has('make_role')).toBe(true)
    expect(tools.has('create_admin_roles')).toBe(false)
    expect(tools.get('make_role')?.path).toBe('/admin/roles')
  })

  it('caps a configured name at the client limit', () => {
    const long = 'x'.repeat(80)
    const app = new Elysia().use(mcp()).post('/a', () => ({}), { mcp: { name: long } })
    const [name] = [...extractRouteTools(app, { prefixes: [] }).keys()]
    expect(name.length).toBeLessThanOrEqual(MAX_TOOL_NAME_LENGTH)
    expect(name.startsWith('xxxx')).toBe(true)
  })

  it('marks a route public through the option', () => {
    const tools = extractRouteTools(createApp(), { prefixes: [] })
    expect(tools.get('get_health')?.public).toBe(true)
    expect(tools.get('make_role')?.public).toBe(false)
  })
})

describe('OpenAPI detail as tool text', () => {
  it('takes title from detail.summary and description from detail.description', () => {
    const meta = extractRouteTools(createApp(), { prefixes: ['/admin/'] }).get('get_admin_roles')
    expect(meta?.title).toBe('List roles')
    expect(meta?.description).toBe('Every realm role, with its composites.')
  })

  it('falls back to the summary when a route has no detail.description', () => {
    const app = new Elysia().post('/admin/apps/publish', () => ({}), { detail: { summary: 'Publish App to Store' } })
    const meta = extractRouteTools(app).get('create_admin_apps_publish')
    expect(meta?.description).toBe('Publish App to Store')
  })

  it('lets the mcp option override detail', () => {
    const app = new Elysia()
      .use(mcp())
      .get('/admin/x', () => ({}), { detail: { summary: 'S', description: 'D' }, mcp: { title: 'T', description: 'M' } })
    const meta = extractRouteTools(app).get('get_admin_x')
    expect(meta?.title).toBe('T')
    expect(meta?.description).toBe('M')
  })

  it('describeTool prefers the declared description and still generates one otherwise', () => {
    const tools = extractRouteTools(createApp(), { prefixes: ['/admin/'] })
    expect(describeTool('make_role', tools.get('make_role') ?? {})).toBe('Create a realm role.')
    const plain = new Elysia().put('/admin/things/:id', () => ({}))
    const meta = extractRouteTools(plain).get('update_admin_things_id') ?? {}
    expect(describeTool('update_admin_things_id', meta)).toBe('Update an existing admin things id. (Admin only)')
  })
})

describe('resources follow the same selection', () => {
  it('drops mcp: false routes and adds marked ones', () => {
    const app = new Elysia()
      .use(mcp())
      .get('/admin/hidden', () => ({}), { mcp: false })
      .get('/admin/shown', () => ({}), { detail: { summary: 'Shown', description: 'A shown thing.' } })
      .get('/status', () => ({}), { mcp: true })
    const resources = extractRouteResources(app, { prefixes: ['/admin/'] })
    expect([...resources.keys()].sort()).toEqual(['admin_shown', 'status'])
    expect(resources.get('admin_shown')?.description).toBe('A shown thing.')
  })
})

describe('describeResource', () => {
  it('prefers the declared description and generates one otherwise', () => {
    expect(describeResource('admin_roles', { description: 'Every role.' })).toBe('Every role.')
    expect(describeResource('admin_roles_by_roleName', {})).toBe('Read admin roles by roleName. (Admin only)')
    expect(describeResource('health', { public: true })).toBe('Read health. (Public)')
  })
})

describe('OpenAPI conventions', () => {
  it('names a tool by detail.operationId, below an explicit mcp name', () => {
    const app = new Elysia()
      .use(mcp())
      .get('/admin/users/:id', () => ({}), { detail: { operationId: 'getUser' } })
      .post('/admin/users', () => ({}), { detail: { operationId: 'createUser' }, mcp: { name: 'add_user' } })
    expect([...extractRouteTools(app).keys()].sort()).toEqual(['add_user', 'getUser'])
  })

  it('keeps detail.hide routes out unless they are marked', () => {
    const app = new Elysia()
      .use(mcp())
      .get('/admin/internal', () => ({}), { detail: { hide: true } })
      .get('/admin/exposed', () => ({}), { detail: { hide: true }, mcp: true })
    expect([...extractRouteTools(app).keys()]).toEqual(['get_admin_exposed'])
    expect([...extractRouteResources(app).keys()]).toEqual(['admin_exposed'])
  })

  it('skips catch-all routes, which have no single method to call', () => {
    const app = new Elysia().all('/admin/proxy/*', () => ({})).get('/admin/x', () => ({}))
    expect([...extractRouteTools(app).keys()]).toEqual(['get_admin_x'])
  })
})
