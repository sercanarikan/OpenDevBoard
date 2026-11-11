/** Below this viewport width the sidebar starts as an icon rail (unless the user chose otherwise). */
export const SIDEBAR_AUTO_COLLAPSE_WIDTH = 1100;

export const SIDEBAR_STORAGE_KEY = 'devopsflow_sidebar';

export type SidebarPref = 'collapsed' | 'expanded' | null;

/** Parses the stored user choice; anything unknown means "no explicit choice" (automatic). */
export const parseSidebarPref = (raw: string | null): SidebarPref =>
  raw === 'collapsed' || raw === 'expanded' ? raw : null;

/** An explicit user choice always wins; without one the sidebar follows the viewport width. */
export const resolveSidebarCollapsed = (pref: SidebarPref, viewportWidth: number): boolean =>
  pref ? pref === 'collapsed' : viewportWidth < SIDEBAR_AUTO_COLLAPSE_WIDTH;

/** Splits the kanban board total into active and completed cards for display only. */
export const kanbanScopeSplit = (total: number, doneColumn: number): { active: number; done: number } => ({
  active: Math.max(0, total - doneColumn),
  done: Math.max(0, doneColumn)
});

/** True while content is clipped on the right, with a 1px tolerance for subpixel rounding. */
export const hasMoreToRight = (scrollLeft: number, clientWidth: number, scrollWidth: number): boolean =>
  scrollWidth - (scrollLeft + clientWidth) > 1;
