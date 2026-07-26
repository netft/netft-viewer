import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import {
  CompanionEventSchema,
  MAXIMUM_LINE_BYTES,
  parseCompanionEventLine,
} from "../../app/main/protocol";

const fixtureLines = (name: string): string[] =>
  readFileSync(resolve("protocol", "fixtures", name), "utf8")
    .trim()
    .split("\n");

const fixtureValues = (name: string): unknown[] =>
  fixtureLines(name).map((line) => JSON.parse(line) as unknown);

const validIpv4 = (value: string): boolean => {
  const parts = value.split(".");
  return (
    parts.length === 4 &&
    parts.every(
      (part) => /^(0|[1-9][0-9]{0,2})$/.test(part) && Number(part) <= 255,
    )
  );
};

const validSensorHost = (value: string): boolean => {
  if (/^[0-9.]+$/.test(value)) {
    return validIpv4(value);
  }
  return (
    value.length <= 253 &&
    value
      .split(".")
      .every(
        (label) =>
          /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label) ||
          /^[A-Za-z0-9]$/.test(label),
      )
  );
};

describe("companion protocol", () => {
  it("accepts every valid event fixture as a typed event", () => {
    for (const line of fixtureLines("valid-events.jsonl")) {
      const parsed = JSON.parse(line) as unknown;
      expect(CompanionEventSchema.safeParse(parsed).success).toBe(true);
      expect(parseCompanionEventLine(line)).toBeDefined();
    }
  });

  it("rejects every invalid event fixture including recursive duplicates", () => {
    for (const line of [
      ...fixtureLines("invalid-events.jsonl"),
      ...fixtureLines("duplicate-events.jsonl"),
    ]) {
      expect(() => parseCompanionEventLine(line)).toThrow();
    }
  });

  it("enforces the UTF-8 byte limit before JSON parsing", () => {
    const manifest = JSON.parse(
      readFileSync(
        resolve("protocol", "fixtures", "oversize-manifest.json"),
        "utf8",
      ),
    ) as {
      limitBytes: number;
      eventPaddingBytes: number;
    };
    const value = JSON.parse(fixtureLines("valid-events.jsonl")[0] ?? "{}") as {
      padding?: string;
    };
    value.padding = "x".repeat(manifest.eventPaddingBytes);
    const line = JSON.stringify(value);
    expect(new TextEncoder().encode(line).byteLength).toBeGreaterThan(
      manifest.limitBytes,
    );
    expect(MAXIMUM_LINE_BYTES).toBe(manifest.limitBytes);
    expect(() => parseCompanionEventLine(line)).toThrow();
  });

  it("keeps draft-compatible command and event schemas aligned with fixtures", () => {
    const ajv = new Ajv2020({
      strict: true,
      strictRequired: false,
      strictTypes: false,
    });
    ajv.addFormat("int64-decimal", {
      type: "string",
      validate: (value: string) =>
        /^(0|[1-9][0-9]*)$/.test(value) &&
        BigInt(value) <= 9_223_372_036_854_775_807n,
    });
    ajv.addFormat("uint64-decimal", {
      type: "string",
      validate: (value: string) =>
        /^(0|[1-9][0-9]*)$/.test(value) &&
        BigInt(value) <= 18_446_744_073_709_551_615n,
    });
    ajv.addFormat("sensor-host", {
      type: "string",
      validate: validSensorHost,
    });
    const envelope = ajv.compile(
      JSON.parse(
        readFileSync(
          resolve("protocol", "schemas", "envelope.schema.json"),
          "utf8",
        ),
      ) as object,
    );
    const commands = ajv.compile(
      JSON.parse(
        readFileSync(
          resolve("protocol", "schemas", "commands.schema.json"),
          "utf8",
        ),
      ) as object,
    );
    const events = ajv.compile(
      JSON.parse(
        readFileSync(
          resolve("protocol", "schemas", "events.schema.json"),
          "utf8",
        ),
      ) as object,
    );

    expect(
      fixtureValues("valid-events.jsonl").every((value) => envelope(value)),
    ).toBe(true);
    expect(
      fixtureValues("valid-commands.jsonl").every((value) => commands(value)),
    ).toBe(true);
    expect(
      fixtureValues("invalid-commands.jsonl").every((v) => !commands(v)),
    ).toBe(true);
    expect(
      fixtureValues("valid-events.jsonl").every((value) => events(value)),
    ).toBe(true);
    expect(fixtureValues("invalid-events.jsonl").every((v) => !events(v))).toBe(
      true,
    );
  });
});
