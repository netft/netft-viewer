import { z } from "zod";

export const EXTERNAL_TARGETS = {
  documentation: "https://github.com/netft/netft-viewer#readme",
  issues: "https://github.com/netft/netft-viewer/issues/new/choose",
  organization: "https://github.com/netft",
} as const;

export const WindowCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("quit") }).strict(),
  z.object({ type: z.literal("toggle-full-screen") }).strict(),
  z
    .object({
      type: z.literal("open-external"),
      target: z.enum(["documentation", "issues", "organization"]),
    })
    .strict(),
]);

export type WindowCommand = z.infer<typeof WindowCommandSchema>;

export const ViewerPlatformSchema = z.enum(["darwin", "linux", "win32"]);
export type ViewerPlatform = z.infer<typeof ViewerPlatformSchema>;

export const WindowStateSchema = z
  .object({
    focused: z.boolean(),
    fullScreen: z.boolean(),
  })
  .strict();
export type WindowState = z.infer<typeof WindowStateSchema>;

export const normalizeViewerPlatform = (
  platform: NodeJS.Platform,
): ViewerPlatform => ViewerPlatformSchema.parse(platform);
