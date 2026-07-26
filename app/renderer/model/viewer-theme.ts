import { useEffect, useState } from "react";

import type { ViewerTheme } from "./app-state";

export type ResolvedViewerTheme = "light" | "dark";

const SYSTEM_THEME_QUERY = "(prefers-color-scheme: dark)";

const systemPrefersDark = (): boolean =>
  typeof window.matchMedia === "function" &&
  window.matchMedia(SYSTEM_THEME_QUERY).matches;

export const useViewerTheme = (
  preference: ViewerTheme,
): ResolvedViewerTheme => {
  const [systemDark, setSystemDark] = useState(
    () => preference === "system" && systemPrefersDark(),
  );

  useEffect(() => {
    if (preference !== "system" || typeof window.matchMedia !== "function") {
      return;
    }
    const media = window.matchMedia(SYSTEM_THEME_QUERY);
    setSystemDark(media.matches);
    const handleChange = (event: MediaQueryListEvent) => {
      setSystemDark(event.matches);
    };
    media.addEventListener("change", handleChange);
    return () => {
      media.removeEventListener("change", handleChange);
    };
  }, [preference]);

  return preference === "system" ? (systemDark ? "dark" : "light") : preference;
};
