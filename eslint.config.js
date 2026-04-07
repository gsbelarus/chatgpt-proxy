import js from "@eslint/js";
import tseslint from "@typescript-eslint/eslint-plugin/use-at-your-own-risk/raw-plugin";
import prettier from "eslint-config-prettier/flat";

const tsFiles = ["src/**/*.ts"];

const recommendedTypeScriptConfig = tseslint.flatConfigs["flat/recommended"].map(
  (config) => ({
    ...config,
    files: tsFiles,
  }),
);

export default [
  {
    ignores: ["build/**", "node_modules/**"],
  },
  {
    ...js.configs.recommended,
    files: tsFiles,
  },
  ...recommendedTypeScriptConfig,
  prettier,
];