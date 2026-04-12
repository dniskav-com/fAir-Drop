module.exports = [
  // Global ignores (was .eslintignore)
  {
    ignores: ['node_modules/**', 'dist/**', 'public/app/**', 'public/*.html'],
  },

  // TypeScript + React rules for source files
  {
    files: ['src/**/*.{ts,tsx,js,jsx}'],
    languageOptions: {
      parser: require('@typescript-eslint/parser'),
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      '@typescript-eslint': require('@typescript-eslint/eslint-plugin'),
      react: require('eslint-plugin-react'),
      'react-hooks': require('eslint-plugin-react-hooks'),
      prettier: require('eslint-plugin-prettier'),
    },
    settings: {
      react: { version: 'detect' },
    },
    rules: {
      // TypeScript unused vars (soft)
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      // React
      'react/prop-types': 'off',
      'react/react-in-jsx-scope': 'off',
      // Prefer explicit module boundary types off for DX
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      // Enforce no semicolons
      semi: ['error', 'never'],
      // Prettier integration
      'prettier/prettier': ['error'],
    },
  },
]
