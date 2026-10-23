/*
 * What every screen gets from the workspace: the state, the config, and the actions that talk to
 * the backend (contracts/events.md). Screens never call the transport themselves.
 */
import type { ReactNode } from 'react';
import type { ResearchState } from './state';
import type { AppConfig, Brief, DataShape, Requirement } from './types';

export interface PlanDraft {
  topic: string;
  brief: Brief;
  subQuestions: { question: string; dataShape: DataShape }[];
  requirements: Requirement[];
}

export interface Actions {
  /** Draft a plan for review: creates the draft project (or redoes the open draft's plan). */
  proposePlan(topic: string, brief: Brief, parentProjectId?: string | null): Promise<void>;
  /** Save the user's edits to the open draft's plan. */
  saveProposal(plan: PlanDraft): Promise<void>;
  /** Start the open draft with the approved plan, or a new project with it when there is no draft. */
  startPlan(plan: PlanDraft): Promise<void>;
  /** Start without reviewing a plan. */
  startDirect(topic: string, brief: Brief, parentProjectId?: string | null): Promise<void>;
  stop(): Promise<void>;
  finishEarly(): Promise<void>;
  redirect(text: string): Promise<boolean>;
  setNotify(enabled: boolean): Promise<void>;
  ask(question: string, selection?: string): Promise<void>;
  /** Incremental re-run of a completed project (the open one unless `projectId` names another). */
  rerun(extraQuestions?: string[], projectId?: string): Promise<void>;
  refreshStatus(): Promise<void>;
  refreshProjects(): Promise<void>;
  askCleanup(projectId: string): void;
  cancelCleanup(projectId: string): void;
  confirmCleanup(projectId: string): Promise<void>;
  highlight(entityId: string | null): void;
  toast(node: ReactNode): void;
}

export interface ScreenProps {
  state: ResearchState;
  config: AppConfig;
  actions: Actions;
  /** A request to the backend is on its way (disables the buttons that would send another). */
  busy: boolean;
}
