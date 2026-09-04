// Model validation against OMP's authenticated model facade.
//
// The facade (`ctx.models` in an extension, or an injected test double)
// supplies `list`, `resolve`, and `family`. Selectors are validated at setup
// time against this facade only; opaque family tokens are never persisted —
// they are recomputed during live route lookup.

import type { ModelChoice, PanelRole, PstackConfig, ScalarRole } from "../core/types";
import { PANEL_ROLES, SCALAR_ROLES } from "../core/types";
import { PstackError } from "../core/errors";

/** Structural view of an OMP catalog model (provider/id is all validation needs). */
export interface ModelLike {
  provider: string;
  id: string;
  name?: string;
}

/**
 * Read-only model query surface. Mirrors `ExtensionModelQuery` so both a live
 * `ctx.models` and a test double satisfy it.
 */
export interface ModelFacade {
  /** Authenticated models available this session. */
  list(): ModelLike[];
  /** Resolve a selector (provider/id[:level]) to a model, or undefined. */
  resolve(selector: string): ModelLike | undefined;
  /** Opaque lineage token: same family iff same token. */
  family(model: ModelLike): string;
}

/** Concrete thinking-effort suffixes accepted on role selectors. */
export const SUPPORTED_REASONING_SUFFIXES = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ReasoningSuffix = (typeof SUPPORTED_REASONING_SUFFIXES)[number];

/** A selector split into provider, model id, and optional thinking level. */
export interface ParsedModelSelector {
  provider: string;
  modelId: string;
  thinkingLevel?: string;
}

/**
 * Split `provider/model[:level]`. A trailing `:<level>` is only recognized
 * when the level is a supported reasoning suffix; anything else stays part of
 * the literal model id (real ids can end in `:max`). Returns null for
 * malformed selectors (no slash, empty provider/id).
 */
export const parseModelSelector = (selector: string): ParsedModelSelector | null => {
  const trimmed = selector.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0) return null;
  const provider = trimmed.slice(0, slash);
  const rest = trimmed.slice(slash + 1);
  if (rest === "") return null;
  const colon = rest.lastIndexOf(":");
  if (colon > 0) {
    const candidate = rest.slice(colon + 1);
    if ((SUPPORTED_REASONING_SUFFIXES as readonly string[]).includes(candidate)) {
      return { provider, modelId: rest.slice(0, colon), thinkingLevel: candidate };
    }
  }
  return { provider, modelId: rest };
};

/** A validated selector: the resolved model plus the verified thinking pin. */
export interface ResolvedSelector {
  model: ModelLike;
  thinkingLevel?: string;
}

/**
 * Validate one exact selector against the facade. Fails closed:
 * - malformed shape -> PSTACK_MODEL_SELECTOR
 * - unknown reasoning suffix (and no literal model) -> PSTACK_REASONING_SUFFIX
 * - unresolvable or not in the authenticated set -> PSTACK_MODEL_UNAVAILABLE
 * The resolved model must be the exact provider/id named by the selector, so
 * aliases and globs can never slip in as role pins.
 */
export const validateModelSelector = (selector: string, facade: ModelFacade): ResolvedSelector => {
  const trimmed = selector.trim();
  const parsed = parseModelSelector(trimmed);
  if (parsed === null) {
    throw new PstackError(
      "PSTACK_MODEL_SELECTOR",
      `selector ${JSON.stringify(selector)} must be provider/model[:level]`,
    );
  }
  const fullModelId = trimmed.slice(trimmed.indexOf("/") + 1);

  const resolved = facade.resolve(trimmed);
  if (resolved === undefined) {
    if (parsed.thinkingLevel === undefined && parsed.modelId.includes(":")) {
      throw new PstackError(
        "PSTACK_REASONING_SUFFIX",
        `selector ${JSON.stringify(selector)} has an unsupported reasoning suffix and no model matches it literally`,
      );
    }
    throw new PstackError(
      "PSTACK_MODEL_UNAVAILABLE",
      `selector ${JSON.stringify(selector)} is not an available authenticated model`,
    );
  }

  let model = resolved;
  let thinkingLevel = parsed.thinkingLevel;
  if (parsed.thinkingLevel !== undefined && resolved.id === fullModelId) {
    // The resolved model kept the suffix in its id: a literal `:max`-style
    // id wins over the thinking-suffix reading (mirrors OMP's literal-first
    // resolution), so no reasoning pin is recorded.
    thinkingLevel = undefined;
  }

  if (
    model.provider !== parsed.provider ||
    (model.id !== parsed.modelId && model.id !== fullModelId)
  ) {
    throw new PstackError(
      "PSTACK_MODEL_UNAVAILABLE",
      `selector ${JSON.stringify(selector)} resolves to ${model.provider}/${model.id}, not ${parsed.provider}/${parsed.modelId}`,
    );
  }
  const inList = facade.list().some((entry) => entry.provider === model.provider && entry.id === model.id);
  if (!inList) {
    throw new PstackError(
      "PSTACK_MODEL_UNAVAILABLE",
      `selector ${JSON.stringify(selector)} is not in the authenticated model set`,
    );
  }
  return { model, thinkingLevel };
};

/** One validated role/seat assignment, with its resolved model. */
export interface ValidatedModelEntry {
  semanticRole: ScalarRole | PanelRole;
  choice: ModelChoice;
  model?: ModelLike;
  thinkingLevel?: string;
  family?: string;
}

/** Result of validating every role and panel seat in a config. */
export interface ValidatedModelConfig {
  entries: ValidatedModelEntry[];
  /** modelRole key (e.g. `pstack-feature`, `pstack-how-critics-1`) -> family token. */
  families: Record<string, string>;
}

/**
 * Validate every concrete selector in a config. Also enforces the cross-family
 * invariant on `arena-cross-judges`: at least two distinct model families must
 * be configured, otherwise a contrasting judge can never be selected
 * (PSTACK_NO_CROSS_FAMILY). inherit-parent seats carry no family and are
 * excluded from the contrast check.
 */
export const validateConfigModels = (config: PstackConfig, facade: ModelFacade): ValidatedModelConfig => {
  const entries: ValidatedModelEntry[] = [];
  const families: Record<string, string> = {};

  const validateChoice = (
    choice: ModelChoice,
    semanticRole: ScalarRole | PanelRole,
    modelRole: string,
  ): void => {
    if (choice.type === "inherit-parent") {
      entries.push({ semanticRole, choice });
      return;
    }
    const resolved = validateModelSelector(choice.selector, facade);
    const family = facade.family(resolved.model);
    families[modelRole] = family;
    entries.push({
      semanticRole,
      choice,
      model: resolved.model,
      thinkingLevel: resolved.thinkingLevel,
      family,
    });
  };

  for (const role of SCALAR_ROLES) {
    validateChoice(config.roles[role], role, `pstack-${role}`);
  }
  for (const panel of PANEL_ROLES) {
    config.panels[panel].forEach((choice, index) => {
      validateChoice(choice, panel, `pstack-${panel}-${index + 1}`);
    });
  }

  const crossJudgeFamilies = new Set<string>();
  for (const entry of entries) {
    if (entry.semanticRole === "arena-cross-judges" && entry.family !== undefined) {
      crossJudgeFamilies.add(entry.family);
    }
  }
  if (crossJudgeFamilies.size < 2) {
    throw new PstackError(
      "PSTACK_NO_CROSS_FAMILY",
      "arena-cross-judges panel must configure at least two distinct model families so a contrasting judge can be selected",
    );
  }

  return { entries, families };
};
