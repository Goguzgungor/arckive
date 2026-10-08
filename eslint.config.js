import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/fixtures/**', '**/.next/**', '**/next-env.d.ts', '**/playwright-report/**', '**/test-results/**'] },
  ...tseslint.configs.recommended,
);
