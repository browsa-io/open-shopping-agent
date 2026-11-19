// Types for wording.js, shared by the web app (served as is) and the CLI (imported from TypeScript).

import type { Money, RunEvent, Stage, StoreId } from "../../src/core/types.js";

export declare const STORE_NAMES: Record<StoreId, string>;
export declare const ALL_STORES: StoreId[];
export declare const NOT_SHOWN: string;
export declare function storeName(store: StoreId, domain?: string): string;
export declare function formatCents(cents: number, currency?: string): string;
export declare function money(m: Money | undefined, fallback?: string): string;

export interface FriendlyError {
  title: string;
  hint: string;
  action: "retry" | "live" | null;
  raw: string;
  stage: Stage | string;
  where: string;
}
export declare function friendlyError(error: string, stage: Stage | string, store: StoreId, domain?: string): FriendlyError;
export declare function shortRaw(raw: string, max?: number): string;

export interface StoreState {
  store: StoreId;
  domain: string;
  started: boolean;
  offers: number;
  failure: { stage: Stage; error: string; at: number } | null;
  lastKind: string;
  [k: string]: unknown;
}
export declare function reduceStores(events: RunEvent[]): { stores: Map<StoreId, StoreState>; order: StoreId[]; picks: unknown; done: boolean };

export declare function orderStateOf(st: StoreState, running: boolean): "placing" | "placed" | "failed" | "unknown" | null;
export declare function unknownText(st: StoreState, stopped?: boolean): string;

export interface StatusWord { word: string; tone: "busy" | "ok" | "warn" | "bad" | "idle"; detail: string; failure?: FriendlyError }
export declare function storeStatus(st: StoreState, ctx: { running: boolean; picked: boolean; gates?: { has(k: string): boolean }; answered?: { has(k: string): boolean } }): StatusWord;

/** Added in 0.2.0: "Bought under your up-front approval (up to $60)" for an order bought without asking, else null. */
export declare function upFrontText(order: { approval_source?: string; mandate?: { maxTotal: Money } } | null | undefined): string | null;
/** Added in 0.2.0: one line for the run's "Buy without asking" setting. */
export declare function mandateSummary(m: { maxTotal: Money; maxRunTotal?: Money; stores?: string[]; expiresAt?: string } | null | undefined): string;
