/**
 * Centralized Azure DevOps Work Item State & Completion Evaluation Module.
 *
 * Implements explicit workflow category mappings based on standard Azure DevOps
 * processes (Agile, Scrum, CMMI, Basic) and provides pure functions for
 * determining terminal completion, active status, and scope eligibility.
 */

export type WorkItemStateCategory =
  | 'Proposed'     // New, To Do, Proposed
  | 'InProgress'   // Active, In Progress, Committed
  | 'Resolved'     // Resolved, Testing (Code complete / in review - NOT counted as Completed by default)
  | 'Completed'    // Closed, Done, Completed (Terminal Completed state)
  | 'Removed';     // Removed (Out of scope, cancelled)

/**
 * Standard State Name to Category mapping with fallback for custom states.
 * States mapped to 'Completed' are terminal completed states.
 * 'Resolved' is explicitly categorized as 'Resolved' (NOT Completed).
 */
export const DEFAULT_STATE_CATEGORY_MAP: Record<string, WorkItemStateCategory> = {
  // Terminal Completed States (Counted in progress numerator)
  'closed': 'Completed',
  'done': 'Completed',
  'completed': 'Completed',

  // Resolved / Verification States (In denominator, but NOT counted in numerator by default)
  'resolved': 'Resolved',
  'testing': 'Resolved',
  'in review': 'Resolved',
  'in-review': 'Resolved',

  // Active / In-Progress States
  'active': 'InProgress',
  'in progress': 'InProgress',
  'in-progress': 'InProgress',
  'committed': 'InProgress',

  // Initial / Proposed States
  'new': 'Proposed',
  'to do': 'Proposed',
  'todo': 'Proposed',
  'proposed': 'Proposed',

  // Removed / Cut States (Excluded from progress denominator)
  'removed': 'Removed'
};

/**
 * Metadata definition for custom project-level workflow state mappings.
 */
export interface WorkflowMetadata {
  /**
   * Project or process-specific state-to-category mapping override.
   * e.g. { 'verified': 'Completed', 'custom-done': 'Completed', 'abandoned': 'Removed' }
   */
  customStateMap?: Record<string, WorkItemStateCategory>;
  /**
   * Project name this workflow configuration applies to.
   */
  project?: string;
  /**
   * Work item type this workflow configuration applies to.
   */
  type?: string;
}

/**
 * Normalizes state string and returns its workflow category.
 *
 * Evaluation Order:
 * 1. Checks custom workflow metadata (if provided).
 * 2. Falls back to centralized DEFAULT_STATE_CATEGORY_MAP.
 * 3. Unknown states default safely to 'InProgress' (never silently assumed Completed).
 */
export function getWorkItemStateCategory(
  state: string,
  metadata?: WorkflowMetadata
): WorkItemStateCategory {
  if (!state) return 'Proposed';
  const clean = state.trim().toLowerCase();

  // 1. Check custom workflow metadata first if provided
  if (metadata?.customStateMap) {
    const customMatch = metadata.customStateMap[clean] || metadata.customStateMap[state.trim()];
    if (customMatch) {
      return customMatch;
    }
  }

  // 2. Centralized fallback mapping
  return DEFAULT_STATE_CATEGORY_MAP[clean] || 'InProgress';
}

export interface CompletionEvaluationOptions {
  /**
   * Optional custom workflow metadata.
   */
  workflowMetadata?: WorkflowMetadata;
  /**
   * Explicit override: only if true would 'Resolved' be treated as completed.
   * Default is FALSE as required.
   */
  treatResolvedAsCompleted?: boolean;
}

/**
 * Determines whether a Work Item is considered completed.
 *
 * Rules:
 * - ONLY states belonging to the 'Completed' category ('Done', 'Closed', 'Completed' or custom) are COMPLETED.
 * - 'Resolved' is NOT considered completed by default (remains in progress denominator, but not numerator).
 * - Ongoing states ('New', 'To Do', 'Active', 'In Progress') are NEVER completed.
 * - 'Removed' is scope-cancelled (not completed).
 * - Unknown states are NEVER silently assumed completed.
 */
export function isWorkItemCompleted(
  state: string,
  _type?: string,
  options?: CompletionEvaluationOptions
): boolean {
  if (!state) return false;

  const category = getWorkItemStateCategory(state, options?.workflowMetadata);

  // Strictly ONLY 'Completed' category is completed
  if (category === 'Completed') {
    return true;
  }

  // Explicit opt-in override for Resolved (default is false)
  if (category === 'Resolved' && options?.treatResolvedAsCompleted === true) {
    return true;
  }

  // Proposed, InProgress, Resolved, Removed, or unknown are NOT completed
  return false;
}

/**
 * Determines whether an item is eligible for progress calculations (In-Scope).
 * 'Removed' work items are cancelled/out-of-scope and excluded from both numerator and denominator.
 */
export function isWorkItemInScope(
  state: string,
  metadata?: WorkflowMetadata
): boolean {
  return getWorkItemStateCategory(state, metadata) !== 'Removed';
}
