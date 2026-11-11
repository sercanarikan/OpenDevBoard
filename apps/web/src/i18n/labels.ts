import type { TFunction } from 'i18next';

/** Localized display label for an Azure DevOps state. Unknown/custom states are shown unchanged. */
export function stateLabel(t: TFunction, state: string): string {
  if (!state) return '';
  return t(`states.${state}`, { defaultValue: state, ns: 'common' }) as string;
}

export function priorityLabel(t: TFunction, priority: number): string {
  const key = `priorities.p${priority}`;
  return t(key, { defaultValue: `P${priority}`, ns: 'common' }) as string;
}
