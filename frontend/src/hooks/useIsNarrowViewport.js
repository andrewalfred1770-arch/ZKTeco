import { useState, useEffect } from 'react';

/**
 * useIsNarrowViewport — reactive matchMedia check for AG Grid pages that pin
 * columns on BOTH sides (e.g. an identity column pinned right + an action/
 * total column pinned left). Pinned columns never shrink or join the
 * scrollable center region — they keep their configured width unconditionally
 * — so two pinned groups whose widths sum past the viewport width will
 * visually overlap each other, no matter how small `minWidth` is set on
 * anything else. The only real fix is to stop pinning the lower-priority
 * side below the width where that sum stops fitting, letting that column
 * flow into the normal horizontally-scrollable region instead.
 *
 * `maxWidth` is the exact breakpoint the caller has verified their pinned
 * columns start overlapping at (varies per grid — how many pinned columns
 * and how wide) — there's no single correct number for every grid, so it's
 * a required argument rather than a hardcoded default.
 */
export function useIsNarrowViewport(maxWidth) {
  const query = `(max-width: ${maxWidth}px)`;
  const [isNarrow, setIsNarrow] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(query).matches
  );

  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = (e) => setIsNarrow(e.matches);
    setIsNarrow(mql.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);

  return isNarrow;
}
