export type WindowReading = { used: number; resetsAt?: number; length: number };
export type Reading = {
  id: string; label: string; type: string; current?: boolean; weight?: number;
  delegate?: string; session?: WindowReading; week?: WindowReading;
  fetchedAt: number; source: string; error?: string; checkedAt?: number;
};
export type AdviceSnapshot = { recommendation: string | null; points: Record<string, number> };
declare module 'claude-code' {
  interface PluginState {
    limitpace: {
      view: { readings: Reading[]; now: number; configError?: string };
      injected: AdviceSnapshot | null;
    };
  }
}
