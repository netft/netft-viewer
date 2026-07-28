import { z } from "zod";

export const MENU_AXES = ["Fx", "Fy", "Fz", "Tx", "Ty", "Tz"] as const;
export const MENU_TIME_WINDOWS = [1, 5, 10, 30, 60] as const;

const AxisSchema = z.enum(MENU_AXES);
const TimeWindowSchema = z.union([
  z.literal(1),
  z.literal(5),
  z.literal(10),
  z.literal(30),
  z.literal(60),
]);

export const MenuStateSchema = z
  .object({
    backendRunning: z.boolean(),
    connection: z.enum([
      "disconnected",
      "connecting",
      "streaming",
      "reconnecting",
      "disconnecting",
      "error",
    ]),
    connectionPending: z.boolean(),
    actionPending: z.boolean(),
    paused: z.boolean(),
    recordingActive: z.boolean(),
    hasSensorHost: z.boolean(),
    plotMode: z.enum(["combined", "panels"]),
    timeWindowSeconds: TimeWindowSchema,
    visibleAxes: z.array(AxisSchema).max(MENU_AXES.length),
  })
  .strict();

export type MenuState = z.infer<typeof MenuStateSchema>;

export const MenuCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("connect") }).strict(),
  z.object({ type: z.literal("disconnect") }).strict(),
  z.object({ type: z.literal("toggle-pause") }).strict(),
  z.object({ type: z.literal("bias") }).strict(),
  z.object({ type: z.literal("toggle-recording") }).strict(),
  z
    .object({
      type: z.literal("set-plot-mode"),
      mode: z.enum(["combined", "panels"]),
    })
    .strict(),
  z
    .object({
      type: z.literal("set-time-window"),
      seconds: TimeWindowSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("toggle-axis"),
      axis: AxisSchema,
    })
    .strict(),
]);

export type MenuCommand = z.infer<typeof MenuCommandSchema>;
