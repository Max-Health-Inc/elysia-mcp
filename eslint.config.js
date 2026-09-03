// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Self-contained on purpose.
 *
 * In the monorepo this imported `../../config/eslint/base.js`. That path does not exist
 * outside it, and `@proxy-smart/eslint-config` is `private: true` and unpublished — a
 * public repository's dev dependencies have to install without a token. The rules below
 * are the ones that base config actually enforced, not a stricter set: a rule added
 * during an extraction shows up as a source change nobody asked for.
 */
import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports', disallowTypeAnnotations: false },
      ],
    },
  },
)
