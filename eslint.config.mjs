import tseslint from "typescript-eslint";

// 首先强制会改变运行行为的规则；历史格式由独立基线逐步收敛。
export default [
  {
    ignores: ["**/dist/**", "**/node_modules/**", "deployment/**", ".openapp/**", ".golutra/**"],
  },
  {
    files: ["**/*.{js,mjs,ts,tsx}"],
    languageOptions: { parser: tseslint.parser, parserOptions: { ecmaFeatures: { jsx: true } } },
    rules: {
      "no-debugger": "error",
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
      "no-unsafe-finally": "error",
      "valid-typeof": "error",
      "no-constant-binary-expression": "error",
      "no-unreachable": "error",
    },
  },
];
