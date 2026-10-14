import { describe, it, expect } from 'bun:test'
import { Elysia } from 'elysia'
import { extractRouteTools, extractRouteResources } from '../src/introspect'
import { executeTool, executeResource } from '../src/executor'

function createApp() {
  const calls: string[] = []
  const app = new Elysia()
    .get('/admin', () => {
      calls.push('admin root')
      return { route: 'admin root' }
    })
    .get('/admin/roles/:roleName', ({ params }) => {
      calls.push(`get ${params.roleName}`)
      return { route: 'role' }
    })
    .delete('/admin/roles/:roleName', ({ params }) => {
      calls.push(`delete role ${params.roleName}`)
      return { route: 'delete role' }
    })
    .delete('/admin/roles/:roleName/members/:userId', ({ params }) => {
      calls.push(`delete member ${params.userId}`)
      return { route: 'delete member' }
    })
  return { app, calls }
}

describe('path params cannot leave their segment', () => {
  it('refuses a dot segment instead of letting the URL parser resolve it to another route', async () => {
    const { app, calls } = createApp()
    const meta = extractRouteTools(app).get('delete_admin_roles_roleName_members_userId')
    expect(meta).toBeDefined()
    if (!meta) return
    const result = await executeTool('delete_admin_roles_roleName_members_userId', meta, { roleName: 'r', userId: '..' }, undefined, app)
    expect(result.isError).toBe(true)
    expect(calls).toEqual([])
  })

  it.each(['.', '..'])('refuses %p on a resource read', async (value) => {
    const { app, calls } = createApp()
    const meta = extractRouteResources(app).get('admin_roles_by_roleName')
    expect(meta).toBeDefined()
    if (!meta) return
    const text = await executeResource(meta, { roleName: value }, undefined, app)
    expect(text).toContain('error')
    expect(calls).toEqual([])
  })

  it('keeps encoded slashes and dots inside the segment', async () => {
    const { app, calls } = createApp()
    const meta = extractRouteTools(app).get('get_admin_roles_roleName')
    if (!meta) throw new Error('missing tool')
    for (const value of ['a/../b', '%2e%2e', '...', 'v1.2']) {
      const result = await executeTool('get_admin_roles_roleName', meta, { roleName: value }, undefined, app)
      expect(result.isError).toBeUndefined()
    }
    expect(calls).toEqual(['get a/../b', 'get %2e%2e', 'get ...', 'get v1.2'])
  })
})
