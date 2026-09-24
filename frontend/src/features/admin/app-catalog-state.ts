import type { AppVersion } from '../../admin-api';

export function sortAppVersions(versions: readonly AppVersion[]): AppVersion[] {
  return [...versions].sort((left, right) => {
    const leftHasRevision = Number.isFinite(left.revision);
    const rightHasRevision = Number.isFinite(right.revision);
    if (leftHasRevision !== rightHasRevision) return leftHasRevision ? -1 : 1;
    if (leftHasRevision && rightHasRevision && left.revision !== right.revision) {
      return right.revision! - left.revision!;
    }

    const createdAtDifference = Date.parse(right.createdAt) - Date.parse(left.createdAt);
    return Number.isFinite(createdAtDifference) ? createdAtDifference : 0;
  });
}

export interface AppVersionRequestState {
  requestedAppId: string;
  selectedAppId: string;
  requestSequence: number;
  latestSequence: number;
  aborted: boolean;
}

export function isCurrentAppVersionRequest(state: AppVersionRequestState): boolean {
  return !state.aborted
    && state.requestedAppId === state.selectedAppId
    && state.requestSequence === state.latestSequence;
}

export interface AppVersionMutationState {
  requestedAppId: string;
  selectedAppId: string;
  mutationSequence: number;
  latestMutationSequence: number;
  mounted: boolean;
}

export function isCurrentAppVersionMutation(state: AppVersionMutationState): boolean {
  return state.mounted
    && state.requestedAppId === state.selectedAppId
    && state.mutationSequence === state.latestMutationSequence;
}
