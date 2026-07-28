import { useState, type ReactNode } from "react";

import { MaterialSymbol } from "./MaterialSymbol";

export interface CollapsibleSectionProps {
  children: ReactNode;
  className: string;
  sectionId: string;
  title: string;
}

export const CollapsibleSection = ({
  children,
  className,
  sectionId,
  title,
}: CollapsibleSectionProps) => {
  const [expanded, setExpanded] = useState(true);
  const contentId = `${sectionId}-content`;

  return (
    <section className={`sidebar-section collapsible-section ${className}`}>
      <h2>
        <button
          aria-controls={contentId}
          aria-expanded={expanded}
          className="sidebar-section-toggle"
          data-testid={`${sectionId}-toggle`}
          onClick={() => {
            setExpanded((current) => !current);
          }}
          type="button"
        >
          <span>{title}</span>
          <MaterialSymbol
            className="collapsible-chevron"
            expanded={expanded}
            name="keyboardArrowDown"
          />
        </button>
      </h2>
      {expanded ? (
        <div
          className="sidebar-section-content"
          data-testid={contentId}
          id={contentId}
        >
          {children}
        </div>
      ) : null}
    </section>
  );
};
