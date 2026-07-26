import { readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { expect, test, type ViewerFixture } from "./fixtures";

const evidencePath = (name: string): string =>
  resolve(
    ".superpowers/sdd/2026-07-26-netft-viewer-implementation-plan/concepts/e2e",
    name,
  );

const connect = async (viewer: ViewerFixture): Promise<void> => {
  await viewer.page.getByTestId("sensor-host-input").fill("198.51.100.10");
  await viewer.page.getByTestId("connection-action").click();
  await expect(viewer.page.getByTestId("connection-state")).toHaveText(
    "Streaming",
  );
};

const expectRendererHealthy = (viewer: ViewerFixture): void => {
  expect(viewer.pageErrors).toEqual([]);
  expect(
    viewer.consoleErrors.filter((entry) => !entry.includes("frame-ancestors")),
  ).toEqual([]);
};

const recordedSequences = async (path: string): Promise<number[]> => {
  const rows = (await readFile(path, "utf8")).trim().split("\n").slice(1);
  return rows.map((row) => Number(row.split(",", 1)[0]));
};

test("packaged app renders live values and both chart layouts", async ({
  viewer,
}) => {
  await expect(viewer.page.getByTestId("viewer-shell")).toBeVisible();
  await expect(viewer.page.getByTestId("connection-action")).toBeEnabled();
  await connect(viewer);

  await viewer.fakeCompanion.emitSample(40);
  await viewer.fakeCompanion.emitSample(41);
  await viewer.fakeCompanion.emitSample(42);
  await expect(viewer.page.getByTestId("raw-Fx")).toHaveText("42");
  await expect(viewer.page.getByTestId("raw-Fy")).toHaveText("-84");
  await expect(viewer.page.getByTestId("value-Fx")).toHaveText("42.100 N");
  await expect(viewer.page.getByTestId("value-Tx")).toHaveText("42.400 N·mm");
  await expect(viewer.page.getByTestId("chart-workspace")).toHaveAttribute(
    "data-point-count",
    "18",
  );
  await expect(viewer.page.getByTestId("chart-surface-combined")).toBeVisible();

  await viewer.page.getByTestId("chart-window-60").click();
  await expect(viewer.page.getByTestId("chart-window-60")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await viewer.page.getByTestId("axis-visibility-Tx").click();
  await expect(viewer.page.getByTestId("chart-workspace")).toHaveAttribute(
    "data-visible-axis-count",
    "5",
  );
  await viewer.page.getByTestId("chart-mode-panels").click();
  await expect(
    viewer.page.locator('[data-testid^="chart-surface-"]'),
  ).toHaveCount(6);
  await viewer.page.screenshot({ path: evidencePath("live-panels.png") });
  expectRendererHealthy(viewer);
});

test("dialogs, Pause, and CSV acceptance stay authoritative", async ({
  viewer,
}) => {
  await connect(viewer);

  await viewer.setDialogs({ messageResponses: [0] });
  await viewer.page.getByTestId("bias-action").click();
  await expect
    .poll(async () => (await viewer.fakeCompanion.state()).biasCount)
    .toBe(0);
  await viewer.setDialogs({ messageResponses: [1] });
  await viewer.page.getByTestId("bias-action").click();
  await expect
    .poll(async () => (await viewer.fakeCompanion.state()).biasCount)
    .toBe(1);
  await expect(
    viewer.page.locator('output[data-result="success"]'),
  ).toHaveCount(1);

  await viewer.setDialogs({
    saveResponses: [{ canceled: true, filePath: "" }],
  });
  await viewer.page.getByTestId("recording-action").click();
  await expect(viewer.page.getByTestId("recording-state")).toHaveText("Idle");

  const recordingPath = join(viewer.tempDirectory, "accepted.csv");
  await viewer.setDialogs({
    saveResponses: [{ canceled: false, filePath: recordingPath }],
  });
  await viewer.page.getByTestId("recording-action").click();
  await expect(viewer.page.getByTestId("recording-state")).toHaveText(
    "Recording",
  );

  await viewer.fakeCompanion.emitSample(1);
  await expect(viewer.page.getByTestId("raw-Fx")).toHaveText("1");
  await viewer.page.getByTestId("pause-action").click();
  await expect(viewer.page.getByTestId("connection-state")).toHaveText(
    "Paused",
  );
  const frozenPointCount =
    (await viewer.page
      .getByTestId("chart-workspace")
      .getAttribute("data-point-count")) ?? "";
  await viewer.fakeCompanion.emitSample(2);
  await expect(viewer.page.getByTestId("raw-Fx")).toHaveText("1");
  await expect(viewer.page.getByTestId("chart-workspace")).toHaveAttribute(
    "data-point-count",
    frozenPointCount,
  );
  await expect
    .poll(async () => (await viewer.fakeCompanion.state()).acceptedSequences)
    .toEqual([1]);
  await viewer.page.screenshot({ path: evidencePath("recording-paused.png") });

  await viewer.page.getByTestId("pause-action").click();
  await expect(viewer.page.getByTestId("connection-state")).toHaveText(
    "Streaming",
  );
  await viewer.fakeCompanion.emitSample(3);
  await expect(viewer.page.getByTestId("raw-Fx")).toHaveText("3");
  await viewer.page.getByTestId("recording-action").click();
  await expect(viewer.page.getByTestId("recording-state")).toHaveText("Idle");
  expect(await recordedSequences(recordingPath)).toEqual([1, 3]);

  const overwritePath = join(viewer.tempDirectory, "overwrite.csv");
  await writeFile(overwritePath, "preserve\n", "utf8");
  await viewer.setDialogs({
    messageResponses: [0],
    saveResponses: [{ canceled: false, filePath: overwritePath }],
  });
  await viewer.page.getByTestId("recording-action").click();
  await expect(viewer.page.getByTestId("recording-state")).toHaveText("Idle");
  expect(await readFile(overwritePath, "utf8")).toBe("preserve\n");
  await viewer.setDialogs({
    messageResponses: [1],
    saveResponses: [{ canceled: false, filePath: overwritePath }],
  });
  await viewer.page.getByTestId("recording-action").click();
  await expect(viewer.page.getByTestId("recording-state")).toHaveText(
    "Recording",
  );
  await viewer.page.getByTestId("recording-action").click();
  await expect(viewer.page.getByTestId("recording-state")).toHaveText("Idle");
  expect(await readFile(overwritePath, "utf8")).toContain("sequence,");
  expectRendererHealthy(viewer);
});

test("recording failures retain a recoverable partial file", async ({
  viewer,
}) => {
  await connect(viewer);
  const recordingPath = join(viewer.tempDirectory, "failure.csv");
  await viewer.setDialogs({
    saveResponses: [{ canceled: false, filePath: recordingPath }],
  });
  await viewer.page.getByTestId("recording-action").click();
  await expect(viewer.page.getByTestId("recording-state")).toHaveText(
    "Recording",
  );
  await viewer.fakeCompanion.emitSample(9);
  const failure = await viewer.fakeCompanion.triggerRecordingError();

  await expect(viewer.page.getByTestId("recording-state")).toHaveText("Error");
  await expect(viewer.page.getByTestId("recording-error-detail")).toBeVisible();
  await expect(
    viewer.page.getByTestId("recording-error-partial"),
  ).not.toHaveText("Unavailable");
  expect((await stat(failure.partialPath)).isFile()).toBe(true);
  await expect(viewer.page.getByTestId("chart-workspace")).toBeVisible();
  await viewer.page.screenshot({ path: evidencePath("recording-error.png") });
  expectRendererHealthy(viewer);
});

test("backend restart and explicit Retry never reconnect the sensor", async ({
  viewer,
}) => {
  await connect(viewer);
  await viewer.fakeCompanion.emitSample(7);
  const initial = await viewer.fakeCompanion.endpoint();
  await viewer.fakeCompanion.exit();
  const restarted = await viewer.fakeCompanion.endpoint(initial.pid);

  await expect(viewer.page.getByTestId("connection-state")).toHaveText(
    "Disconnected",
  );
  await expect(viewer.page.getByTestId("connection-action")).toBeEnabled();
  expect((await viewer.fakeCompanion.state()).connected).toBe(false);

  await viewer.fakeCompanion.failRestarts();
  await expect(viewer.page.getByTestId("backend-error-view")).toBeVisible({
    timeout: 10_000,
  });
  await viewer.page.screenshot({ path: evidencePath("backend-failed.png") });
  await viewer.clearFailureSentinel();
  await viewer.page.getByTestId("retry-backend").click();
  await viewer.fakeCompanion.endpoint(restarted.pid);
  await expect(viewer.page.getByTestId("backend-error-view")).toHaveCount(0);
  await expect(viewer.page.getByTestId("connection-state")).toHaveText(
    "Disconnected",
  );
  await expect(viewer.page.getByTestId("connection-action")).toBeEnabled();
  expect((await viewer.fakeCompanion.state()).connected).toBe(false);
  await viewer.page.screenshot({ path: evidencePath("backend-retried.png") });
  expectRendererHealthy(viewer);
});
