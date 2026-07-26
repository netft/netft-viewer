import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_PREFERENCES,
  SettingsStore,
} from "../../app/main/settings-store";

const temporaryDirectories: string[] = [];

const makeDirectory = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "netft-viewer-settings-"));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("SettingsStore", () => {
  it("falls back to defaults for corrupt or unknown persisted data", () => {
    const directory = makeDirectory();
    writeFileSync(
      join(directory, "settings.json"),
      JSON.stringify({
        version: 1,
        preferences: { ...DEFAULT_PREFERENCES, recordingPath: "/tmp/x.csv" },
      }),
    );

    const store = new SettingsStore(directory);

    expect(store.snapshot()).toEqual(DEFAULT_PREFERENCES);
    expect(store.snapshot()).not.toHaveProperty("recordingPath");
  });

  it("serializes concurrent updates without losing fields", async () => {
    const directory = makeDirectory();
    const store = new SettingsStore(directory);

    const first = store.update({ plotMode: "panels" });
    const second = store.update({ timeWindowSeconds: 30 });
    await Promise.all([first, second]);

    expect(store.snapshot()).toMatchObject({
      plotMode: "panels",
      timeWindowSeconds: 30,
    });
    const persisted = JSON.parse(
      readFileSync(join(directory, "settings.json"), "utf8"),
    ) as { version: number; preferences: Record<string, unknown> };
    expect(persisted.version).toBe(1);
    expect(Object.keys(persisted.preferences).sort()).toEqual([
      "plotMode",
      "sensorHost",
      "theme",
      "timeWindowSeconds",
      "visibleAxes",
    ]);
  });

  it("rejects invalid patches and retains the last valid snapshot", async () => {
    const store = new SettingsStore(makeDirectory());
    await store.update({ theme: "dark" });

    await expect(
      store.update({ timeWindowSeconds: 2 } as never),
    ).rejects.toThrow();
    expect(store.snapshot().theme).toBe("dark");
    expect(store.snapshot().timeWindowSeconds).toBe(10);
  });

  it("rejects a malformed sensor host instead of persisting typed text", async () => {
    const store = new SettingsStore(makeDirectory());

    await expect(store.update({ sensorHost: "bad host" })).rejects.toThrow();

    expect(store.snapshot().sensorHost).toBe(DEFAULT_PREFERENCES.sensorHost);
  });

  it("refuses a symbolic-link settings target", async () => {
    const directory = makeDirectory();
    const external = join(directory, "external.json");
    writeFileSync(external, "{}");
    symlinkSync(external, join(directory, "settings.json"));

    expect(() => new SettingsStore(directory)).toThrow(/settings target/);
    expect(lstatSync(join(directory, "settings.json")).isSymbolicLink()).toBe(
      true,
    );
  });

  it("writes private regular files and leaves no sibling temporary file", async () => {
    const directory = makeDirectory();
    const store = new SettingsStore(directory);

    await store.update({ theme: "light" });

    const metadata = lstatSync(join(directory, "settings.json"));
    expect(metadata.isFile()).toBe(true);
    if (process.platform !== "win32") {
      expect(metadata.mode & 0o777).toBe(0o600);
    }
  });

  it("retains the last valid snapshot when a later atomic write is blocked", async () => {
    const directory = makeDirectory();
    const store = new SettingsStore(directory);
    await store.update({ theme: "dark" });
    const target = join(directory, "settings.json");
    const external = join(directory, "external.json");
    writeFileSync(external, "{}");
    unlinkSync(target);
    symlinkSync(external, target);

    await expect(store.update({ theme: "light" })).rejects.toThrow();

    expect(store.snapshot().theme).toBe("dark");
  });
});
