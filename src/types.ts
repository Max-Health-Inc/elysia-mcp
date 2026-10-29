// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: Apache-2.0

import type { TSchema } from '@sinclair/typebox'

/** MCP tool annotations: untrusted UX hints, not a security boundary. @see https://modelcontextprotocol.io/specification/2025-11-25/server/tools */
export interface ToolAnnotations {
  title?: string
  /** Tool does not modify state. Default (MCP): false. */
  readOnlyHint?: boolean
  /** Tool may perform destructive updates (only meaningful when not read-only). Default (MCP): true. */
  destructiveHint?: boolean
  /** Repeated calls with the same args have no additional effect. Default (MCP): false. */
  idempotentHint?: boolean
  /** Tool interacts with an open/external world (vs. a closed domain). Default (MCP): true. */
  openWorldHint?: boolean
}

/** Metadata extracted from a single Elysia route for use as an MCP tool */
export interface ToolMetadata {
  path: string
  method: string
  handler: unknown
  /** Body/query schema */
  schema?: TSchema
  paramsSchema?: TSchema
  /** Becomes the tool's `outputSchema`; safe because Elysia coerces the response to it. */
  responseSchema?: TSchema
  title?: string
  description?: string
  /** Tool requires no authentication */
  public?: boolean
  readOnly?: boolean
  /** Derived from the HTTP method, see `annotationsForMethod` */
  annotations?: ToolAnnotations
}

/** Metadata extracted from a GET route for use as an MCP resource */
export interface ResourceMetadata {
  path: string
  /** Always GET */
  method: string
  handler: unknown
  paramsSchema?: TSchema
  title?: string
  description?: string
  /** Resource requires no authentication */
  public?: boolean
  pathParams: string[]
}
