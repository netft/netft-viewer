import type { NetftApi } from "./index";

declare global {
  interface Window {
    readonly netft: NetftApi;
  }
}

export {};
