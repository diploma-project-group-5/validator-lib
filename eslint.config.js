import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// The domain is pure (ADR 2026-11-09): no clock, randomness, process, console or Node APIs.
const pureCore = {
  files: ['src/domain/**/*.ts', 'src/boundary/**/*.ts'],
  rules: {
    'no-restricted-globals': ['error', 'process', 'console', 'Date', 'Intl'],
    'no-restricted-properties': ['error', { object: 'Math', property: 'random' }],
    'no-restricted-imports': [
      'error',
      { patterns: ['node:*', '../boundary/*', '../cli/*', '../../boundary/*', '../../cli/*'] },
    ],
  },
};

export default tseslint.config(
  { ignores: ['dist/', 'coverage/', 'node_modules/', 'src/generated/'] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
  { files: ['**/*.js', '**/*.mjs'], ...tseslint.configs.disableTypeChecked },
  { files: ['scripts/**/*.mjs'], languageOptions: { globals: { URL: 'readonly', console: 'readonly' } } },
  pureCore,
);
