// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: Apache-2.0

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function isArgs(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && !Array.isArray(value)
}

export function nonEmptyText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}
