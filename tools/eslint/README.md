# ESLint toolchain

The application compiles and type-checks with the repository-pinned TypeScript
7 release. The pinned `typescript-eslint` release intentionally requires the
TypeScript 6 JavaScript API, so linting runs from this private workspace with an
exact TypeScript 6 dependency.

`check-toolchain.mjs` verifies both resolutions before every lint run. This
prevents a hoisting or package-manager change from silently loading the
unsupported product TypeScript version into ESLint.
