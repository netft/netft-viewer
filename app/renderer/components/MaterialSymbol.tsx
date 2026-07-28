import type { CSSProperties } from "react";

import cropLandscape from "@material-symbols/svg-300/rounded/crop_landscape.svg";
import error from "@material-symbols/svg-300/rounded/error.svg";
import check from "@material-symbols/svg-300/rounded/check.svg";
import keyboardArrowDown from "@material-symbols/svg-300/rounded/keyboard_arrow_down.svg";
import keyboardArrowRight from "@material-symbols/svg-300/rounded/keyboard_arrow_right.svg";
import lan from "@material-symbols/svg-300/rounded/lan.svg";
import moreHoriz from "@material-symbols/svg-300/rounded/more_horiz.svg";
import viewModule from "@material-symbols/svg-300/rounded/view_module.svg";
import warning from "@material-symbols/svg-300/rounded/warning.svg";

const SYMBOL_SOURCES = {
  cropLandscape,
  check,
  error,
  keyboardArrowDown,
  keyboardArrowRight,
  lan,
  moreHoriz,
  viewModule,
  warning,
} as const;

export type MaterialSymbolName = keyof typeof SYMBOL_SOURCES;

export interface MaterialSymbolProps {
  className?: string;
  expanded?: boolean;
  name: MaterialSymbolName;
}

export const MaterialSymbol = ({
  className = "",
  expanded,
  name,
}: MaterialSymbolProps) => (
  <span
    aria-hidden="true"
    className={`material-symbol ${className}`.trim()}
    data-expanded={expanded}
    data-symbol-style="rounded"
    style={
      {
        "--material-symbol-source": `url("${SYMBOL_SOURCES[name]}")`,
      } as CSSProperties
    }
  />
);
