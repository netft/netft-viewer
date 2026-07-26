import { z } from "zod";

export const PROTOCOL_MAJOR = 1 as const;
export const PROTOCOL_MINOR = 0 as const;
export const MAXIMUM_LINE_BYTES = 1024 * 1024;
export const MAXIMUM_JSON_NESTING_DEPTH = 64;
export const MAXIMUM_REQUEST_ID_BYTES = 128;
export const MAXIMUM_PROTOCOL_MINOR = 4_294_967_295;
export const MINIMUM_RAW_WRENCH = -2_147_483_648;
export const MAXIMUM_RAW_WRENCH = 2_147_483_647;

const canonicalDecimal = /^(0|[1-9][0-9]*)$/;
const maximumInt64 = 9_223_372_036_854_775_807n;
const maximumUint64 = 18_446_744_073_709_551_615n;

const decimalString = (maximum: bigint) =>
  z
    .string()
    .regex(canonicalDecimal)
    .refine((value) => BigInt(value) <= maximum);

export const NanosecondsSchema = decimalString(maximumInt64);
export const CounterSchema = decimalString(maximumUint64);

const ProtocolVersionSchema = z.object({
  major: z.literal(PROTOCOL_MAJOR),
  minor: z.number().int().nonnegative().max(MAXIMUM_PROTOCOL_MINOR),
});

const RequestIdSchema = z
  .string()
  .min(1)
  .max(MAXIMUM_REQUEST_ID_BYTES)
  .regex(/^[A-Za-z0-9_.:-]+$/);

export const EnvelopeSchema = z.object({
  protocol: ProtocolVersionSchema,
  type: z.string(),
  requestId: RequestIdSchema.optional(),
  monotonicNs: NanosecondsSchema,
  payload: z.unknown(),
});

const eventEnvelope = <Type extends string, Payload extends z.ZodType>(
  type: Type,
  payload: Payload,
  correlated = false,
) =>
  z.object({
    protocol: ProtocolVersionSchema,
    type: z.literal(type),
    ...(correlated
      ? { requestId: RequestIdSchema }
      : { requestId: RequestIdSchema.optional() }),
    monotonicNs: NanosecondsSchema,
    payload,
  });

const CommandTypeSchema = z.enum([
  "connect",
  "disconnect",
  "set_paused",
  "bias",
  "start_recording",
  "stop_recording",
  "shutdown",
]);

const HelloEventSchema = eventEnvelope(
  "hello",
  z.object({
    protocolMajor: z.literal(PROTOCOL_MAJOR),
    protocolMinor: z.number().int().nonnegative().max(MAXIMUM_PROTOCOL_MINOR),
    appVersion: z.string().min(1),
    coreSnapshot: z.string().regex(/^[0-9a-f]{40}$/),
  }),
  true,
);

const CommandResultEventSchema = eventEnvelope(
  "command_result",
  z
    .object({
      commandType: CommandTypeSchema,
      success: z.boolean(),
      errorCode: z.string().min(1).optional(),
      errorMessage: z.string().min(1).optional(),
    })
    .superRefine((payload, context) => {
      if (
        !payload.success &&
        (payload.errorCode === undefined || payload.errorMessage === undefined)
      ) {
        context.addIssue({
          code: "custom",
          message: "failed command results require error details",
        });
      }
    }),
  true,
);

const ConnectionStateEventSchema = eventEnvelope(
  "connection_state",
  z.object({
    state: z.enum([
      "disconnected",
      "connecting",
      "streaming",
      "reconnecting",
      "disconnecting",
      "error",
    ]),
    paused: z.boolean(),
    generation: CounterSchema,
    lastError: z.string(),
  }),
);

const optionalSequence = z
  .number()
  .int()
  .nonnegative()
  .max(4_294_967_295)
  .nullable();

const ConfigurationPayloadSchema = z.object({
  productName: z.string(),
  countsPerForceUnit: z.number().finite().positive(),
  countsPerTorqueUnit: z.number().finite().positive(),
  forceUnit: z.enum(["unknown", "lbf", "N", "klbf", "kN", "kgf"]),
  torqueUnit: z.enum([
    "unknown",
    "lbf-in",
    "lbf-ft",
    "N-m",
    "N-mm",
    "kgf-cm",
    "kN-m",
  ]),
  source: z.enum(["sensor", "override"]),
  revision: CounterSchema,
});

const HealthEventSchema = eventEnvelope(
  "health",
  z.object({
    state: z.enum(["stopped", "connecting", "streaming", "backoff", "faulted"]),
    faultCode: z.enum([
      "none",
      "sensor_configuration",
      "timeout",
      "socket",
      "serious_status",
      "ft_stall",
      "ft_backward",
      "malformed_storm",
      "callback",
    ]),
    sensorHost: z.string(),
    rdtPort: z.number().int().nonnegative().max(65_535),
    sensorConfiguration: ConfigurationPayloadSchema.optional(),
    lastRdtSequence: optionalSequence,
    lastFtSequence: optionalSequence,
    lastStatus: z.number().int().nonnegative().max(4_294_967_295),
    receiveRateHz: z.number().finite().nonnegative(),
    deliveryRateHz: z.number().finite().nonnegative(),
    receivedCount: CounterSchema,
    deliveredCount: CounterSchema,
    rateLimitedCount: CounterSchema,
    deviceErrorCount: CounterSchema,
    warningCount: CounterSchema,
    lostCount: CounterSchema,
    duplicateCount: CounterSchema,
    outOfOrderCount: CounterSchema,
    malformedCount: CounterSchema,
    reconnectCount: CounterSchema,
    timeoutCount: CounterSchema,
    callbackErrorCount: CounterSchema,
    ftStallCount: CounterSchema,
    ftBackwardCount: CounterSchema,
    ftRestartCount: CounterSchema,
    calibrationChangeCount: CounterSchema,
    lastRecordAgeNs: NanosecondsSchema.nullable(),
    lastError: z.string(),
    lastFtProgress: z.string(),
  }),
);

const WrenchEventSchema = eventEnvelope(
  "live_wrench",
  z.object({
    hostTimeNs: NanosecondsSchema,
    sampleMonotonicNs: NanosecondsSchema,
    rdtSequence: z.number().int().nonnegative().max(4_294_967_295),
    ftSequence: z.number().int().nonnegative().max(4_294_967_295),
    status: z.number().int().nonnegative().max(4_294_967_295),
    raw: z.tuple([
      z.number().int().min(MINIMUM_RAW_WRENCH).max(MAXIMUM_RAW_WRENCH),
      z.number().int().min(MINIMUM_RAW_WRENCH).max(MAXIMUM_RAW_WRENCH),
      z.number().int().min(MINIMUM_RAW_WRENCH).max(MAXIMUM_RAW_WRENCH),
      z.number().int().min(MINIMUM_RAW_WRENCH).max(MAXIMUM_RAW_WRENCH),
      z.number().int().min(MINIMUM_RAW_WRENCH).max(MAXIMUM_RAW_WRENCH),
      z.number().int().min(MINIMUM_RAW_WRENCH).max(MAXIMUM_RAW_WRENCH),
    ]),
    force: z.tuple([
      z.number().finite(),
      z.number().finite(),
      z.number().finite(),
    ]),
    torque: z.tuple([
      z.number().finite(),
      z.number().finite(),
      z.number().finite(),
    ]),
    forceUnit: ConfigurationPayloadSchema.shape.forceUnit,
    torqueUnit: ConfigurationPayloadSchema.shape.torqueUnit,
    configurationRevision: CounterSchema,
  }),
);

const plotAxis = <Axis extends "Fx" | "Fy" | "Fz" | "Tx" | "Ty" | "Tz">(
  axis: Axis,
) =>
  z.object({
    axis: z.literal(axis),
    points: z
      .array(
        z.object({
          hostTimeNs: NanosecondsSchema,
          value: z.number().finite(),
        }),
      )
      .max(4),
  });

const PlotBatchEventSchema = eventEnvelope(
  "plot_batch",
  z.object({
    axes: z.tuple([
      plotAxis("Fx"),
      plotAxis("Fy"),
      plotAxis("Fz"),
      plotAxis("Tx"),
      plotAxis("Ty"),
      plotAxis("Tz"),
    ]),
  }),
);

const RecordingStateEventSchema = eventEnvelope(
  "recording_state",
  z.object({
    state: z.enum([
      "idle",
      "starting",
      "recording",
      "pausing",
      "paused",
      "stopping",
      "error",
    ]),
    partialPath: z.string(),
    lastError: z.string(),
  }),
);

const RecordingProgressEventSchema = eventEnvelope(
  "recording_progress",
  z.object({
    acceptedSamples: CounterSchema,
    writtenSamples: CounterSchema,
    bytesWritten: CounterSchema,
    queueSize: CounterSchema,
    queueCapacity: CounterSchema,
  }),
);

const ConfigurationEventSchema = eventEnvelope(
  "configuration_changed",
  ConfigurationPayloadSchema,
);

const ErrorEventSchema = eventEnvelope(
  "error",
  z.object({
    operation: z.enum([
      "protocol",
      "connect",
      "disconnect",
      "pause",
      "resume",
      "bias",
      "start_recording",
      "stop_recording",
      "sensor",
      "recording",
    ]),
    message: z.string(),
    errorCode: z.string().min(1).optional(),
    sequence: CounterSchema,
    droppedBefore: CounterSchema,
  }),
);

export const CompanionEventSchema = z.discriminatedUnion("type", [
  HelloEventSchema,
  CommandResultEventSchema,
  ConnectionStateEventSchema,
  HealthEventSchema,
  WrenchEventSchema,
  PlotBatchEventSchema,
  RecordingStateEventSchema,
  RecordingProgressEventSchema,
  ConfigurationEventSchema,
  ErrorEventSchema,
]);

export type CompanionEvent = z.infer<typeof CompanionEventSchema>;

const assertNoDuplicateObjectKeys = (source: string): void => {
  let cursor = 0;
  const whitespace = /\s/;

  const skipWhitespace = () => {
    while (cursor < source.length && whitespace.test(source[cursor] ?? "")) {
      cursor += 1;
    }
  };

  const parseString = (): string => {
    const start = cursor;
    cursor += 1;
    let escaped = false;
    while (cursor < source.length) {
      const character = source[cursor];
      cursor += 1;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        return JSON.parse(source.slice(start, cursor)) as string;
      }
    }
    throw new Error("unterminated JSON string");
  };

  const parseValue = (depth: number): void => {
    skipWhitespace();
    const character = source[cursor];
    if (character === "{") {
      if (depth >= MAXIMUM_JSON_NESTING_DEPTH) {
        throw new Error("JSON nesting depth exceeds protocol limit");
      }
      cursor += 1;
      const keys = new Set<string>();
      skipWhitespace();
      if (source[cursor] === "}") {
        cursor += 1;
        return;
      }
      for (;;) {
        skipWhitespace();
        if (source[cursor] !== '"') {
          throw new Error("invalid object key");
        }
        const key = parseString();
        if (keys.has(key)) {
          throw new Error("duplicate object key");
        }
        keys.add(key);
        skipWhitespace();
        if (source[cursor] !== ":") {
          throw new Error("missing object separator");
        }
        cursor += 1;
        parseValue(depth + 1);
        skipWhitespace();
        if (source[cursor] === "}") {
          cursor += 1;
          return;
        }
        if (source[cursor] !== ",") {
          throw new Error("missing object delimiter");
        }
        cursor += 1;
      }
    }
    if (character === "[") {
      if (depth >= MAXIMUM_JSON_NESTING_DEPTH) {
        throw new Error("JSON nesting depth exceeds protocol limit");
      }
      cursor += 1;
      skipWhitespace();
      if (source[cursor] === "]") {
        cursor += 1;
        return;
      }
      for (;;) {
        parseValue(depth + 1);
        skipWhitespace();
        if (source[cursor] === "]") {
          cursor += 1;
          return;
        }
        if (source[cursor] !== ",") {
          throw new Error("missing array delimiter");
        }
        cursor += 1;
      }
    }
    if (character === '"') {
      parseString();
      return;
    }
    const start = cursor;
    while (cursor < source.length && !/[\s,\]}]/.test(source[cursor] ?? "")) {
      cursor += 1;
    }
    if (cursor === start) {
      throw new Error("invalid JSON value");
    }
  };

  parseValue(0);
  skipWhitespace();
  if (cursor !== source.length) {
    throw new Error("trailing JSON data");
  }
};

export const parseCompanionEventLine = (line: string): CompanionEvent => {
  if (new TextEncoder().encode(line).byteLength > MAXIMUM_LINE_BYTES) {
    throw new Error("protocol line exceeds byte limit");
  }
  if (line.length === 0 || line.includes("\n") || line.includes("\r")) {
    throw new Error("protocol input must contain exactly one JSON line");
  }
  assertNoDuplicateObjectKeys(line);
  return CompanionEventSchema.parse(JSON.parse(line) as unknown);
};
