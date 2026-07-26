export const IPC_CHANNELS = {
  connect: "netft:connect",
  disconnect: "netft:disconnect",
  setPaused: "netft:set-paused",
  requestBias: "netft:request-bias",
  startRecording: "netft:start-recording",
  stopRecording: "netft:stop-recording",
  retryBackend: "netft:retry-backend",
  getPreferences: "netft:get-preferences",
  updatePreferences: "netft:update-preferences",
  event: "netft:event",
} as const;
