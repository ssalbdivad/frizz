"use client";

import { useEffect, useRef } from "react";
import { markPath } from "./mark-path";

// The fff mark, drawn as the one continuous stroke it is: on load the dash is parked at the path's full
// length and the transition in global.css unrolls it. Reduced motion skips the draw.
export function Mark({ className }: { className?: string }) {
  const path = useRef<SVGPathElement>(null);
  useEffect(() => {
    const el = path.current;
    if (!el || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const len = el.getTotalLength();
    el.style.transition = "none";
    el.style.strokeDasharray = String(len);
    el.style.strokeDashoffset = String(len);
    el.getBoundingClientRect();
    el.style.transition = "";
    el.style.strokeDashoffset = "0";
  }, []);
  return (
    <svg viewBox="144.5 41.7 435.4 428.5" xmlns="http://www.w3.org/2000/svg" className={className} aria-hidden>
      <defs>
        <radialGradient id="ink" gradientUnits="userSpaceOnUse" cx="362.2" cy="256.0" r="217.7">
          <stop offset="0" stopColor="#ffdf7f" />
          <stop offset="0.62" stopColor="#eabe2c" />
          <stop offset="1" stopColor="#cf9412" />
        </radialGradient>
      </defs>
      <path
        ref={path}
        id="fff-path"
        d={markPath}
        fill="none"
        stroke="url(#ink)"
        strokeWidth="20.73"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
