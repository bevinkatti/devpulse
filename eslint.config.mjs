import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      "**/node_modules/**",
      ".node_modules-validation-backup/**",
      ".pnpm-store/**",
      "**/dist/**",
      "**/.next/**",
      "apps/dashboard/next-env.d.ts",
      "coverage/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{js,mjs,cjs,ts,mts,cts}"],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
);
