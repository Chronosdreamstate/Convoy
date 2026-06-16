/** @type {import('eslint').Linter.Config} */
module.exports = {
  extends: ['../../.eslintrc.base.js'],
  env: {
    node: true,
    es2022: true,
  },
  parserOptions: {
    project: './tsconfig.json',
    tsconfigRootDir: __dirname,
  },
};
