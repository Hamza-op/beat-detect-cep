export interface AppState {
  busy: boolean;
  activeTab: string;
  selectedClipIdentity?: string;
  analyzedEvents: Array<{ time: number; score: number }>;
  lastAppliedMarkerTimes: number[];
}

export function createInitialState(): AppState {
  return {
    busy: false,
    activeTab: "markers",
    analyzedEvents: [],
    lastAppliedMarkerTimes: [],
  };
}
