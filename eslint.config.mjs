import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// Flat config. Lints the product TypeScript source (src/**/*.ts). dist/ (build output),
// node_modules, and the .mjs test/script/tooling helpers are out of scope — the shipped
// runtime is what the lint gate protects. typescript-eslint recommended composes with the
// project's existing `tsc --strict` typecheck (they overlap little: tsc owns types, eslint
// owns lint-class defects).
export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'test/**', 'scripts/**', '*.mjs'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    rules: {
      // Allow `_`-prefixed identifiers to be intentionally unused — an established convention here
      // for discarded destructures (`const { x: _ignored, ...rest }`) and ignored catch bindings.
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
        destructuredArrayIgnorePattern: '^_',
      }],
      // Off (opinionated eslint@10 additions that fight this codebase's deliberate style):
      // - preserve-caught-error: errors are composed via the `errorMessage(err)` helper, not by
      //   attaching `{ cause }`; forcing cause everywhere would be a broad, inconsistent churn.
      // - no-useless-assignment: false-positives on the defensive `let x = null; try { x = … }
      //   catch { x = null }` idiom used throughout the durable-record readers.
      'preserve-caught-error': 'off',
      'no-useless-assignment': 'off',
      // A `let` that is read (captured by a closure) before its single assignment is a legitimate
      // forward-reference pattern here (e.g. a finalizer promise referenced by its own settle
      // handler), not a missed `const`.
      'prefer-const': ['error', { ignoreReadBeforeAssign: true }],
    },
  },
);
