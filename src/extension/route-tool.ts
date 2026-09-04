/**
 * pstack_route: resolve a semantic role (or generated agent name) to the
 * generated agent roster with live-validated model selectors.
 *
 * Scalar roles resolve to exactly one generated agent; panels resolve to every
 * configured seat in configured order. `excludeSelector` filters a panel down
 * to seats from a contrasting model family for cross-judging: the selector is
 * validated and resolved through the live model facade, and seats whose family
 * matches the excluded model are dropped. When no contrasting seat survives,
 * the tool fails closed with PSTACK_NO_CONTRASTING_SEAT — it never substitutes
 * a same-family seat.
 */
import { z } from "@oh-my-pi/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { PstackError } from "../core/errors";
import { PANEL_ROLES, SCALAR_ROLES, panelSeatAgentName, scalarAgentName } from "../core/types";
import type { ModelChoice, PanelRole, PstackConfig, ScalarRole } from "../core/types";
import { validateModelSelector } from "../setup/catalog";
import type { ModelFacade } from "../setup/catalog";

/** One resolved agent in the roster: generated name, configured selector, live model. */
export interface RouteAgent {
  /** Generated agent name, e.g. `pstack-feature` or `pstack-how-critics-2`. */
  readonly agent: string;
  readonly role: ScalarRole | PanelRole;
  /** Configured selector (`provider/model[:level]`); `"inherit-parent"` for inheriting seats. */
  readonly selector: string;
  /** Resolved provider/id after facade validation; null for inherit-parent. */
  readonly model: string | null;
}

/** Result of one route resolution, with the excluded-selector filter applied. */
export interface RouteResolution {
  readonly role: string;
  readonly agents: readonly RouteAgent[];
}

const isScalarRole = (value: string): value is ScalarRole =>
  (SCALAR_ROLES as readonly string[]).includes(value);

const isPanelRole = (value: string): value is PanelRole =>
  (PANEL_ROLES as readonly string[]).includes(value);

/** What a role argument names: a scalar, a whole panel, or one panel seat. */
type RoleRef =
  | { readonly kind: "scalar"; readonly role: ScalarRole }
  | { readonly kind: "panel"; readonly role: PanelRole }
  | { readonly kind: "seat"; readonly role: PanelRole; readonly seat: number };

/** Parse a semantic role name (`feature`, `how-critics`). */
const parseRoleName = (raw: string): RoleRef | undefined => {
  const role = raw.trim();
  if (isScalarRole(role)) return { kind: "scalar", role };
  if (isPanelRole(role)) return { kind: "panel", role };
  return undefined;
};

/** Parse a generated agent name (`pstack-feature`, `pstack-arena-cross-judges-2`). */
const parseAgentName = (raw: string): RoleRef | undefined => {
  const name = raw.trim();
  if (!name.startsWith("pstack-")) return undefined;
  const inner = name.slice("pstack-".length);
  if (isScalarRole(inner)) return { kind: "scalar", role: inner };
  for (const panel of PANEL_ROLES) {
    if (!inner.startsWith(`${panel}-`)) continue;
    const seatText = inner.slice(panel.length + 1);
    if (/^\d+$/.test(seatText)) {
      const seat = Number(seatText);
      if (seat >= 1) return { kind: "seat", role: panel, seat };
    }
  }
  return undefined;
};

const validRoleList = (): string =>
  `scalars: ${SCALAR_ROLES.join(", ")}; panels: ${PANEL_ROLES.join(", ")}`;

/** A configured seat to resolve: one scalar, one panel seat. */
type SeatRef =
  | { readonly kind: "scalar"; readonly role: ScalarRole; readonly choice: ModelChoice }
  | { readonly kind: "panel"; readonly role: PanelRole; readonly seat: number; readonly choice: ModelChoice };

/** Resolve one seat's choice into a RouteAgent, validating against the facade. */
const resolveSeat = (
  ref: SeatRef,
  models: ModelFacade,
): { agent: RouteAgent; family: string | null } => {
  const role: ScalarRole | PanelRole = ref.role;
  const agent =
    ref.kind === "scalar" ? scalarAgentName(ref.role) : panelSeatAgentName(ref.role, ref.seat);
  if (ref.choice.type === "inherit-parent") {
    return { agent: { agent, role, selector: "inherit-parent", model: null }, family: null };
  }
  try {
    const resolved = validateModelSelector(ref.choice.selector, models);
    return {
      agent: {
        agent,
        role,
        selector: ref.choice.selector,
        model: `${resolved.model.provider}/${resolved.model.id}`,
      },
      family: models.family(resolved.model),
    };
  } catch (error) {
    if (error instanceof PstackError) {
      throw new PstackError(
        error.code,
        `${error.message} (role ${JSON.stringify(role)})`,
        { cause: error },
      );
    }
    throw error;
  }
};

/**
 * Resolve a role to its generated agents with validated selectors.
 *
 * Throws PSTACK_SETUP_MISSING when no config is loaded, PSTACK_UNKNOWN_ROLE for
 * an unrecognized role, and the catalog's model errors when a configured
 * selector cannot be resolved (each naming the offending role). With
 * `excludeSelector`, only seats from a different model family survive; zero
 * survivors raise PSTACK_NO_CONTRASTING_SEAT naming the role.
 */
export const resolveRoute = (
  config: PstackConfig | undefined,
  models: ModelFacade,
  role: string,
  excludeSelector?: string,
): RouteResolution => {
  if (config === undefined) {
    throw new PstackError(
      "PSTACK_SETUP_MISSING",
      "pstack setup is missing; run /setup-pstack first",
    );
  }
  const ref = parseRoleName(role) ?? parseAgentName(role);
  if (ref === undefined) {
    throw new PstackError(
      "PSTACK_UNKNOWN_ROLE",
      `unknown pstack role ${JSON.stringify(role)}; valid ${validRoleList()}`,
    );
  }

  const seats: SeatRef[] =
    ref.kind === "scalar"
      ? [{ kind: "scalar", role: ref.role, choice: config.roles[ref.role] }]
      : ref.kind === "panel"
        ? config.panels[ref.role].map((choice, index) => ({
            kind: "panel" as const,
            role: ref.role,
            seat: index + 1,
            choice,
          }))
        : (() => {
            const panel = config.panels[ref.role];
            if (ref.seat > panel.length) {
              throw new PstackError(
                "PSTACK_UNKNOWN_ROLE",
                `role ${JSON.stringify(role)} names seat ${ref.seat}, but ${ref.role} has ${panel.length} seat(s)`,
              );
            }
            return [
              { kind: "panel" as const, role: ref.role, seat: ref.seat, choice: panel[ref.seat - 1] },
            ];
          })();

  let resolved = seats.map((seat) => resolveSeat(seat, models));

  if (excludeSelector !== undefined && excludeSelector.trim() !== "") {
    const excluded = validateModelSelector(excludeSelector.trim(), models);
    const excludedFamily = models.family(excluded.model);
    resolved = resolved.filter((entry) => entry.family !== null && entry.family !== excludedFamily);
    if (resolved.length === 0) {
      throw new PstackError(
        "PSTACK_NO_CONTRASTING_SEAT",
        `no contrasting seat for role ${JSON.stringify(role)} after excluding ${JSON.stringify(excludeSelector.trim())}; all configured seats share that model family`,
      );
    }
  }

  return { role: ref.role, agents: resolved.map((entry) => entry.agent) };
};

/** Runtime accessor for the live pstack config (loaded by the extension). */
export interface RouteToolRuntime {
  getConfig(): PstackConfig | undefined;
}

/** pstack_route parameter schema (a named const so TParams inference is stable). */
const routeParamsSchema = z.object({
  role: z
    .string()
    .describe(
      "Semantic role or generated agent name (e.g. feature, how-critics, pstack-arena-cross-judges-1)",
    ),
  excludeSelector: z
    .string()
    .describe("provider/model[:level] selector to exclude; only contrasting-family seats remain")
    .optional(),
});

export function registerRouteTool(pi: ExtensionAPI, runtime: RouteToolRuntime): void {
  pi.registerTool({
    name: "pstack_route",
    label: "Pstack route",
    description:
      "Resolve a pstack role to its generated agent name(s) and current model " +
      "selectors. Pass excludeSelector (a provider/model selector) to keep only " +
      "contrasting-family seats for cross-judging; fails closed when no " +
      "contrasting seat is configured.",
    parameters: routeParamsSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) {
      try {
        const result = resolveRoute(runtime.getConfig(), ctx.models, params.role, params.excludeSelector);
        const text = result.agents
          .map((entry) => `${entry.agent}: ${entry.selector}`)
          .join("\n");
        return {
          content: [{ type: "text" as const, text }],
          details: { ...result, excludeSelector: params.excludeSelector },
        };
      } catch (error) {
        if (error instanceof PstackError) {
          return {
            content: [{ type: "text" as const, text: `${error.code}: ${error.message}` }],
            details: { error: error.code, message: error.message },
            isError: true,
          };
        }
        throw error;
      }
    },
  });
}
