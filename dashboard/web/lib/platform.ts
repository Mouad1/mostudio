type NavigatorLike = { platform?: string; userAgentData?: { platform?: string } } | undefined;

/** True when the browser runs on macOS (Finder exists). */
export function isMac(nav: NavigatorLike = globalThis.navigator as NavigatorLike): boolean {
  const platform = nav?.userAgentData?.platform || nav?.platform || "";
  return /mac/i.test(platform);
}

/** Label for a button that reveals a file in the system file manager. */
export function revealLabel(nav?: NavigatorLike): string {
  return isMac(nav ?? (globalThis.navigator as NavigatorLike)) ? "Show in Finder" : "Show in folder";
}
