// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: Apache-2.0

import { Elysia } from 'elysia'
import { isRecord, nonEmptyText } from './guards.js'

export interface McpRouteConfig {
  name?: string
  title?: string
  description?: string
  public?: boolean
}

export type McpRouteOption = boolean | McpRouteConfig

export function mcp() {
  return new Elysia({ name: '@maxhealth.tech/elysia-mcp' }).macro({
    mcp: (_option: McpRouteOption) => ({}),
  })
}

export function readMcpOption(value: unknown): McpRouteOption | undefined {
  if (typeof value === 'boolean') return value
  if (!isRecord(value)) return undefined
  const config: McpRouteConfig = {}
  const name = nonEmptyText(value.name)
  const title = nonEmptyText(value.title)
  const description = nonEmptyText(value.description)
  const isPublic = value.public
  if (name) config.name = name
  if (title) config.title = title
  if (description) config.description = description
  if (typeof isPublic === 'boolean') config.public = isPublic
  return config
}

export function isRouteSelected(option: McpRouteOption | undefined, path: string, prefixes: readonly string[]): boolean {
  if (option === false) return false
  if (option !== undefined) return true
  return prefixes.some((prefix) => path.startsWith(prefix))
}

export function routeConfig(option: McpRouteOption | undefined): McpRouteConfig {
  return typeof option === 'object' ? option : {}
}
