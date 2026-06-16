/** @type {import('eslint').Linter.Config} */
module.exports = {
  extends: ['../../.eslintrc.base.js'],
  plugins: ['react', 'react-hooks', 'react-native'],
  env: {
    browser: true,
    es2022: true,
    'react-native/react-native': true,
  },
  settings: {
    react: {
      version: 'detect',
    },
  },
  parserOptions: {
    project: './tsconfig.json',
    tsconfigRootDir: __dirname,
  },
  rules: {
    'react/react-in-jsx-scope': 'off',
    'react-hooks/rules-of-hooks': 'error',
    'react-hooks/exhaustive-deps': 'warn',
  },
};
