import { lstatSync, type Stats } from "node:fs";
import { dirname, extname, isAbsolute, normalize, resolve } from "node:path";

import type { MessageBoxOptions, SaveDialogOptions } from "electron";

import type { RecordingSelection } from "./ipc-handlers";

export interface NativeDialog {
  showMessageBox(options: MessageBoxOptions): Promise<{ response: number }>;
  showSaveDialog(
    options: SaveDialogOptions,
  ): Promise<{ canceled: boolean; filePath: string }>;
}

export interface DialogServiceOptions {
  dialog: NativeDialog;
  now?: () => Date;
}

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

export const recordingFilename = (now: Date): string => {
  const timestamp = now
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replaceAll(":", "")
    .replace("T", "-");
  return `netft-${timestamp}.csv`;
};

const validatedRecordingTarget = (
  selectedPath: string,
): { targetPath: string; exists: boolean } => {
  if (
    !isAbsolute(selectedPath) ||
    extname(selectedPath).toLowerCase() !== ".csv"
  ) {
    throw new Error("invalid recording destination");
  }
  const targetPath = normalize(resolve(selectedPath));
  const parent = metadataIfPresent(dirname(targetPath));
  if (
    parent === undefined ||
    parent.isSymbolicLink() ||
    !parent.isDirectory()
  ) {
    throw new Error("unsafe recording destination directory");
  }
  const target = metadataIfPresent(targetPath);
  if (target !== undefined && (target.isSymbolicLink() || !target.isFile())) {
    throw new Error("unsafe recording destination");
  }
  return { targetPath, exists: target !== undefined };
};

export class DialogService {
  private readonly now: () => Date;
  private pendingBias: Promise<boolean> | undefined;
  private pendingRecording: Promise<RecordingSelection | undefined> | undefined;

  constructor(private readonly options: DialogServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  confirmBias(): Promise<boolean> {
    this.pendingBias ??= this.confirmBiasOnce().finally(() => {
      this.pendingBias = undefined;
    });
    return this.pendingBias;
  }

  selectRecordingPath(): Promise<RecordingSelection | undefined> {
    this.pendingRecording ??= this.selectRecordingPathOnce().finally(() => {
      this.pendingRecording = undefined;
    });
    return this.pendingRecording;
  }

  private async confirmBiasOnce(): Promise<boolean> {
    const result = await this.options.dialog.showMessageBox({
      type: "warning",
      buttons: ["Cancel", "Apply Bias"],
      cancelId: 0,
      defaultId: 0,
      noLink: true,
      title: "Confirm Bias",
      message: "Apply sensor Bias?",
      detail:
        "Verify that the sensor has a safe, stable, and expected load before continuing.",
    });
    return result.response === 1;
  }

  private async selectRecordingPathOnce(): Promise<
    RecordingSelection | undefined
  > {
    const selection = await this.options.dialog.showSaveDialog({
      defaultPath: recordingFilename(this.now()),
      filters: [{ name: "CSV", extensions: ["csv"] }],
      properties: ["createDirectory"],
      title: "Record force and torque data",
    });
    if (selection.canceled || selection.filePath.length === 0) {
      return undefined;
    }
    const target = validatedRecordingTarget(selection.filePath);
    if (!target.exists) {
      return { targetPath: target.targetPath, overwrite: false };
    }
    const confirmation = await this.options.dialog.showMessageBox({
      type: "warning",
      buttons: ["Cancel", "Replace"],
      cancelId: 0,
      defaultId: 0,
      noLink: true,
      title: "Replace existing recording?",
      message: "A file already exists at the selected destination.",
      detail: "Replacing it requires explicit authorization.",
    });
    return confirmation.response === 1
      ? { targetPath: target.targetPath, overwrite: true }
      : undefined;
  }
}
