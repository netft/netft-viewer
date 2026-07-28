import tseslint from "typescript-eslint";

export default tseslint.config(...tseslint.configs.recommended, {
  ignores: ["build/**", "node_modules/**", ".vite/**", "out/**"],
});
