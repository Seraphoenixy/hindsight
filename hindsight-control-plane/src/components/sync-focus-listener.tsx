"use client";

import { useEffect, useRef } from "react";

const FOCUS_DEBOUNCE_MS = 3000;

/**
 * Triggers a lightweight background sync check when the Control Plane window regains focus.
 */
export function SyncFocusListener() {
  const lastTriggeredRef = useRef<number>(0);

  useEffect(() => {
    const triggerCheck = () => {
      const now = Date.now();
      if (now - lastTriggeredRef.current < FOCUS_DEBOUNCE_MS) {
        return;
      }
      lastTriggeredRef.current = now;
      void fetch("/api/sync/trigger", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ automatic: true }),
      }).catch(() => undefined);
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        triggerCheck();
      }
    };

    window.addEventListener("focus", triggerCheck);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", triggerCheck);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return null;
}
