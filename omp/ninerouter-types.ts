/**
 * Hand-owned contract for the generated `ninerouter.ts` bundle. The bundle is
 * emitted without type annotations, so the surface the router actually uses is
 * named here. Regenerating the transport must keep this contract satisfied;
 * anything that drifts shows up as a type error at the call sites in index.ts.
 */

/** One gateway model as the transport describes it, before quota is observed. */
export interface NineRouterDescription {
  ref: string;
  id: string;
  canonicalRef?: string;
  prefix?: string;
  provider: string;
  subscribed?: boolean;
  allowed?: boolean;
  payg?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  supportsImages?: boolean;
  supportsTools?: boolean;
  reasoning?: boolean;
  autoQualified?: boolean;
  reason?: string;
}

/** A gateway model registered with the host's catalog. */
export interface NineRouterModel {
  id: string;
  name?: string;
  api: string;
  provider: string;
  gateway: true;
  baseUrl: string;
  reasoning?: boolean;
  input: string[];
  contextWindow?: number;
  maxTokens?: number;
  supportsImages?: boolean;
  supportsTools?: boolean;
  payg?: boolean;
  canonicalRef?: string;
}

export interface NineRouterController {
  /** False when the key, catalog or root is unavailable; every accessor stays safe. */
  enabled: boolean;
  provider: string;
  api: string;
  baseUrl: string;
  models: NineRouterModel[];
  canonicalRef: (value: string) => string | undefined;
  describe: (value: string) => NineRouterDescription | undefined;
  isAllowed: (value: string) => boolean;
  dispose: () => void;
}
