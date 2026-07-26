import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { z } from "zod";

const AxesSchema = z.enum(["Fx", "Fy", "Fz", "Tx", "Ty", "Tz"]);
const TimeWindowSchema = z.union([
  z.literal(1),
  z.literal(5),
  z.literal(10),
  z.literal(30),
  z.literal(60),
]);

export const SensorHostSchema = z
  .string()
  .min(1)
  .max(253)
  .refine((value) => {
    if (/^[0-9.]+$/.test(value)) {
      const parts = value.split(".");
      return (
        parts.length === 4 &&
        parts.every(
          (part) => /^(0|[1-9][0-9]{0,2})$/.test(part) && Number(part) <= 255,
        )
      );
    }
    return value
      .split(".")
      .every((label) =>
        /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label),
      );
  });

export const PreferencesSchema = z
  .object({
    sensorHost: SensorHostSchema,
    plotMode: z.enum(["combined", "panels"]),
    timeWindowSeconds: TimeWindowSchema,
    visibleAxes: z.array(AxesSchema).max(6),
    theme: z.enum(["light", "dark", "system"]),
  })
  .strict()
  .superRefine((preferences, context) => {
    if (
      new Set(preferences.visibleAxes).size !== preferences.visibleAxes.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["visibleAxes"],
        message: "visible axes must be unique",
      });
    }
  });

export const PreferencesPatchSchema = z
  .object({
    sensorHost: PreferencesSchema.shape.sensorHost.optional(),
    plotMode: PreferencesSchema.shape.plotMode.optional(),
    timeWindowSeconds: TimeWindowSchema.optional(),
    visibleAxes: PreferencesSchema.shape.visibleAxes.optional(),
    theme: PreferencesSchema.shape.theme.optional(),
  })
  .strict();

export type ViewerPreferences = z.infer<typeof PreferencesSchema>;
export type PreferencesPatch = z.infer<typeof PreferencesPatchSchema>;

export const DEFAULT_PREFERENCES: ViewerPreferences = Object.freeze({
  sensorHost: "192.168.1.1",
  plotMode: "combined",
  timeWindowSeconds: 10,
  visibleAxes: [
    "Fx",
    "Fy",
    "Fz",
    "Tx",
    "Ty",
    "Tz",
  ] as ViewerPreferences["visibleAxes"],
  theme: "system",
});

const StoredSettingsSchema = z
  .object({
    version: z.literal(1),
    preferences: PreferencesSchema,
  })
  .strict();

const clone = (preferences: ViewerPreferences): ViewerPreferences => ({
  ...preferences,
  visibleAxes: [...preferences.visibleAxes],
});

const metadataIfPresent = (path: string): Stats | undefined => {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
};

const requireRegularTargetOrMissing = (path: string): Stats | undefined => {
  const metadata = metadataIfPresent(path);
  if (
    metadata !== undefined &&
    (metadata.isSymbolicLink() || !metadata.isFile())
  ) {
    throw new Error(`refusing unsafe settings target: ${basename(path)}`);
  }
  return metadata;
};

const safelyFsyncDirectory = (directory: string): void => {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(directory, constants.O_RDONLY);
    fsyncSync(descriptor);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (
      !["EINVAL", "ENOTSUP", "EBADF", "EPERM", "EISDIR"].includes(code ?? "")
    ) {
      throw error;
    }
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
};

export class SettingsStore {
  readonly path: string;

  private value: ViewerPreferences;
  private writeTail: Promise<void> = Promise.resolve();

  constructor(userDataPath: string, filename = "settings.json") {
    if (
      basename(filename) !== filename ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(filename)
    ) {
      throw new Error("invalid settings filename");
    }
    const directory = resolve(userDataPath);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const directoryMetadata = lstatSync(directory);
    if (
      directoryMetadata.isSymbolicLink() ||
      !directoryMetadata.isDirectory()
    ) {
      throw new Error("refusing unsafe settings directory");
    }
    if (process.platform !== "win32") {
      chmodSync(directory, 0o700);
    }
    this.path = join(directory, filename);
    requireRegularTargetOrMissing(this.path);
    this.value = this.read();
  }

  snapshot(): ViewerPreferences {
    return clone(this.value);
  }

  update(input: unknown): Promise<ViewerPreferences> {
    const operation = this.writeTail.then(() => {
      const patch = PreferencesPatchSchema.parse(input);
      const next = PreferencesSchema.parse({
        ...this.value,
        ...patch,
        visibleAxes:
          patch.visibleAxes === undefined
            ? this.value.visibleAxes
            : [...patch.visibleAxes],
      });
      this.write(next);
      this.value = clone(next);
      return this.snapshot();
    });
    this.writeTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private read(): ViewerPreferences {
    const metadata = requireRegularTargetOrMissing(this.path);
    if (metadata === undefined) {
      return clone(DEFAULT_PREFERENCES);
    }
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      const current = StoredSettingsSchema.safeParse(parsed);
      if (current.success) {
        return clone(current.data.preferences);
      }
      const legacy = PreferencesSchema.safeParse(parsed);
      return legacy.success ? clone(legacy.data) : clone(DEFAULT_PREFERENCES);
    } catch {
      return clone(DEFAULT_PREFERENCES);
    }
  }

  private write(preferences: ViewerPreferences): void {
    requireRegularTargetOrMissing(this.path);
    const directory = dirname(this.path);
    const temporaryPath = join(
      directory,
      `.${basename(this.path)}.${randomUUID()}.tmp`,
    );
    const noFollow =
      process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0);
    let descriptor: number | undefined;
    try {
      descriptor = openSync(
        temporaryPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
        0o600,
      );
      if (!fstatSync(descriptor).isFile()) {
        throw new Error("refusing non-regular settings temporary file");
      }
      if (process.platform !== "win32") {
        fchmodSync(descriptor, 0o600);
      }
      writeFileSync(
        descriptor,
        `${JSON.stringify({ version: 1, preferences }, null, 2)}\n`,
        "utf8",
      );
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      requireRegularTargetOrMissing(this.path);
      renameSync(temporaryPath, this.path);
      if (process.platform !== "win32") {
        chmodSync(this.path, 0o600);
      }
      safelyFsyncDirectory(directory);
    } catch (error) {
      if (descriptor !== undefined) {
        closeSync(descriptor);
      }
      if (metadataIfPresent(temporaryPath) !== undefined) {
        unlinkSync(temporaryPath);
      }
      throw error;
    }
  }
}
