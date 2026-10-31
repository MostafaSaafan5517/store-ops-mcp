import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules', 'dist', 'coverage', '.data'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      'no-console': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    // The core must stay runtime-agnostic (it runs on Cloudflare Workers in Run 3).
    // Node APIs are allowed only in the Node entry points and the local PGlite adapter.
    files: ['src/**/*.ts'],
    ignores: ['src/stdio.ts', 'src/db/pglite.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['node:*'], message: 'Keep src/ runtime-agnostic.' }] },
      ],
    },
  },
  prettier,
);
