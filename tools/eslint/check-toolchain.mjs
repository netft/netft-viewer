import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const productRequire = createRequire(resolve("package.json"));
const lintRequire = createRequire(resolve("tools/eslint/package.json"));

const productTypeScriptPath = resolve("node_modules/typescript/package.json");
const lintTypeScriptPath = resolve(
  "tools/eslint/node_modules/typescript/package.json",
);
const productResolvedPath = productRequire.resolve("typescript/package.json");
const lintResolvedPath = lintRequire.resolve("typescript/package.json");
const productTypeScript = productRequire(productResolvedPath).version;
const lintTypeScript = lintRequire(lintResolvedPath).version;

lintRequire("typescript-eslint");

if (
  productTypeScript !== "7.0.2" ||
  lintTypeScript !== "6.0.3" ||
  realpathSync(productTypeScriptPath) !== realpathSync(productResolvedPath) ||
  realpathSync(lintTypeScriptPath) !== realpathSync(lintResolvedPath)
) {
  throw new Error("unexpected TypeScript toolchain resolution");
}

process.stdout.write(
  `${JSON.stringify({
    productTypeScript,
    productTypeScriptPath,
    lintTypeScript,
    lintTypeScriptPath,
  })}\n`,
);
