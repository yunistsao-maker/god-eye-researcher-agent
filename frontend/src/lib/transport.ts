import type { ResearchEvent } from '../types';
import type { LogKind } from '../state';

export interface StartResearchArgs {
  projectId: string;
  topic: string;
  parentProjectId: string | null;
}

/** Tool names are the short names (`project_list`); transports add the `project-tools___` prefix. */
export type ProjectToolName = 'project_list' | 'project_get' | 'project_restart' | 'project_cleanup' | 'project_save';

export interface Transport {
  readonly mode: 'mock' | 'live';
  /** Resolves once the subscription is active. The returned function unsubscribes. */
  subscribe(projectId: string, onEvent: (event: ResearchEvent) => void): Promise<() => void>;
  startResearch(args: StartResearchArgs): Promise<void>;
  /** The tool result is parsed JSON from the gateway; callers narrow it to the contract types. */
  callTool(name: ProjectToolName | string, args: Record<string, unknown>): Promise<any>;
  /** Optional cleanup (closes sockets, stops timers). */
  dispose?(): void;
}

/** Gateway call / note logger supplied by the app. EV rows are logged by the app for every received event. */
export type LogFn = (kind: LogKind, text: string) => void;

export const PROJECT_TOOLS_TARGET = 'project-tools';

export function wireToolName(name: string): string {
  return name.includes('___') ? name : `${PROJECT_TOOLS_TARGET}___${name}`;
}
