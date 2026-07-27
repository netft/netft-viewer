const PLATFORM_ARCHITECTURES = new Map([
  ["darwin", new Set(["arm64", "universal", "x64"])],
  ["linux", new Set(["arm64", "x64"])],
  ["win32", new Set(["x64"])],
]);

export const assertPlatformArchitecture = (platform, architecture) => {
  if (!PLATFORM_ARCHITECTURES.get(platform)?.has(architecture)) {
    throw new Error(
      `unsupported desktop target: ${String(platform)}/${String(architecture)}`,
    );
  }
};

export const assertNativeTarget = ({
  hostPlatform,
  hostArchitecture,
  targetPlatform,
  targetArchitecture,
}) => {
  assertPlatformArchitecture(targetPlatform, targetArchitecture);
  if (targetPlatform !== hostPlatform) {
    throw new Error("desktop artifacts require their native operating system");
  }
  if (
    targetArchitecture !== hostArchitecture &&
    !(targetPlatform === "darwin" && targetArchitecture === "universal")
  ) {
    throw new Error("desktop artifacts require their native architecture");
  }
};
