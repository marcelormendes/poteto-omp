// Pstack role configuration: strict config parsing and deterministic
// checksum helpers. Canonical role/config/path/error vocabulary lives in
// src/core (types, paths, errors); this module owns parsing, validation, and
// serialization of ~/.omp/agent/pstack/config.yml and re-exports the core
// vocabulary for setup-internal consumers.

import { createHash } from "node:crypto";
import type {
  ModelChoice,
  PanelRole,
  PstackConfig,
  RoleName,
  ScalarRole,
} from "../core/types";
import {
  PANEL_ROLES,
  PSTACK_SCHEMA_VERSION,
  SCALAR_ROLES,
  UPSTREAM_COMMIT,
} from "../core/types";
import { PstackError } from "../core/errors";
import type { PstackErrorCode } from "../core/errors";
import { isNonEmptyString, isRecord } from "../core/guards";
import { parseYaml, stringifyYaml } from "../core/yaml";
import type { PstackPaths } from "../core/paths";
import { resolvePstackPaths } from "../core/paths";

export {
  PANEL_ROLES,
  PSTACK_SCHEMA_VERSION,
  SCALAR_ROLES,
  UPSTREAM_COMMIT,
  PstackError,
  resolvePstackPaths,
};
export type {
  ModelChoice,
  PanelRole,
  PstackConfig,
  PstackErrorCode,
  PstackPaths,
  RoleName,
  ScalarRole,
};

/** sha256 hex of a UTF-8 string. */
export const sha256Hex = (content: string): string =>
  createHash("sha256").update(content, "utf8").digest("hex");

const describePath = (path: string): string => `config ${path}`;

/**
 * Parse one ModelChoice from validated YAML. Strict: only the two documented
 * shapes are accepted; extra keys and blank selectors are rejected.
 */
export const parseModelChoice = (value: unknown, where: string): ModelChoice => {
  if (!isRecord(value)) {
    throw new PstackError(
      "PSTACK_CONFIG_INVALID",
      `${describePath(where)} must be a mapping with type model|inherit-parent, got ${String(value)}`,
    );
  }
  const keys = Object.keys(value);
  if (value.type === "inherit-parent") {
    if (keys.length !== 1) {
      throw new PstackError(
        "PSTACK_CONFIG_INVALID",
        `${describePath(where)} inherit-parent choice must not carry extra keys: ${keys.join(", ")}`,
      );
    }
    return { type: "inherit-parent" };
  }
  if (value.type === "model") {
    const extra = keys.filter((key) => key !== "type" && key !== "selector");
    if (extra.length > 0) {
      throw new PstackError(
        "PSTACK_CONFIG_INVALID",
        `${describePath(where)} model choice has unknown keys: ${extra.join(", ")}`,
      );
    }
    if (!isNonEmptyString(value.selector)) {
      throw new PstackError(
        "PSTACK_CONFIG_INVALID",
        `${describePath(where)} model choice requires a non-empty selector`,
      );
    }
    return { type: "model", selector: value.selector.trim() };
  }
  throw new PstackError(
    "PSTACK_CONFIG_INVALID",
    `${describePath(where)} has unknown choice type ${String(value.type)} (expected model|inherit-parent)`,
  );
};

/**
 * Strictly validate an untyped config value. Every scalar role and every
 * panel must be present; panels must be non-empty; unknown keys fail instead
 * of being discarded; schema version must be the canonical one.
 */
export const validateCompleteConfig = (value: unknown): PstackConfig => {
  if (!isRecord(value)) {
    throw new PstackError("PSTACK_CONFIG_INVALID", "config must be a mapping");
  }

  const allowedTopLevel = new Set([
    "schemaVersion",
    "upstreamCommit",
    "autoEnable",
    "setupChecksum",
    "roles",
    "panels",
  ]);
  const unknownTop = Object.keys(value).filter((key) => !allowedTopLevel.has(key));
  if (unknownTop.length > 0) {
    throw new PstackError(
      "PSTACK_CONFIG_INVALID",
      `config has unknown top-level keys: ${unknownTop.join(", ")}`,
    );
  }

  if (value.schemaVersion !== PSTACK_SCHEMA_VERSION) {
    throw new PstackError(
      "PSTACK_CONFIG_INVALID",
      `config schemaVersion must be ${PSTACK_SCHEMA_VERSION}, got ${String(value.schemaVersion)}`,
    );
  }

  const missing: string[] = [];
  if (typeof value.autoEnable !== "boolean") missing.push("autoEnable");
  if (
    value.upstreamCommit !== undefined &&
    (typeof value.upstreamCommit !== "string" || value.upstreamCommit.trim() === "")
  ) {
    throw new PstackError("PSTACK_CONFIG_INVALID", "config upstreamCommit must be a non-empty string");
  }
  if (value.setupChecksum !== undefined && !isNonEmptyString(value.setupChecksum)) {
    throw new PstackError("PSTACK_CONFIG_INVALID", "config setupChecksum must be a non-empty string");
  }

  const rolesValue = value.roles;
  if (!isRecord(rolesValue)) {
    missing.push("roles");
  } else {
    const roleKeys = Object.keys(rolesValue);
    const unknownRoles = roleKeys.filter((key) => !(SCALAR_ROLES as readonly string[]).includes(key));
    if (unknownRoles.length > 0) {
      throw new PstackError(
        "PSTACK_CONFIG_INVALID",
        `config roles has unknown roles: ${unknownRoles.join(", ")}`,
      );
    }
    for (const role of SCALAR_ROLES) {
      if (!(role in rolesValue)) missing.push(`roles.${role}`);
    }
  }

  const panelsValue = value.panels;
  if (!isRecord(panelsValue)) {
    missing.push("panels");
  } else {
    const panelKeys = Object.keys(panelsValue);
    const unknownPanels = panelKeys.filter((key) => !(PANEL_ROLES as readonly string[]).includes(key));
    if (unknownPanels.length > 0) {
      throw new PstackError(
        "PSTACK_CONFIG_INVALID",
        `config panels has unknown panels: ${unknownPanels.join(", ")}`,
      );
    }
    for (const panel of PANEL_ROLES) {
      if (!(panel in panelsValue)) {
        missing.push(`panels.${panel}`);
        continue;
      }
      const entries = panelsValue[panel];
      if (!Array.isArray(entries) || entries.length === 0) {
        missing.push(`panels.${panel}`);
      }
    }
  }

  if (missing.length > 0) {
    throw new PstackError(
      "PSTACK_CONFIG_INCOMPLETE",
      `config is missing required entries: ${missing.join(", ")}`,
    );
  }

  // The checks above established both maps are records with every required
  // key present; assert the invariant at this boundary.
  const rolesMap = rolesValue as Record<string, unknown>;
  const panelsMap = panelsValue as Record<string, unknown>;
  const roles = {} as Record<ScalarRole, ModelChoice>;
  for (const role of SCALAR_ROLES) {
    roles[role] = parseModelChoice(rolesMap[role], `roles.${role}`);
  }
  const panels = {} as Record<PanelRole, ModelChoice[]>;
  for (const panel of PANEL_ROLES) {
    const entries = panelsMap[panel] as unknown[];
    panels[panel] = entries.map((entry, index) => parseModelChoice(entry, `panels.${panel}[${index}]`));
  }

  const config: PstackConfig = {
    schemaVersion: PSTACK_SCHEMA_VERSION,
    upstreamCommit:
      typeof value.upstreamCommit === "string" && value.upstreamCommit.trim() !== ""
        ? value.upstreamCommit.trim()
        : UPSTREAM_COMMIT,
    autoEnable: value.autoEnable as boolean,
    roles,
    panels,
    ...(typeof value.setupChecksum === "string" ? { setupChecksum: value.setupChecksum } : {}),
  };
  return config;
};

/** Parse and strictly validate pstack config YAML. */
export const parsePstackConfig = (source: string): PstackConfig => {
  const value = parseYaml(source, "pstack config");
  if (value === null || value === undefined) {
    throw new PstackError("PSTACK_CONFIG_PARSE", "pstack config YAML is empty");
  }
  return validateCompleteConfig(value);
};

/**
 * Serialize a config to the canonical on-disk YAML: fixed key order, no
 * anchors. Deterministic across runs so checksums stay stable.
 */
export const stringifyConfig = (config: PstackConfig): string => {
  const record: Record<string, unknown> = {
    schemaVersion: config.schemaVersion,
    upstreamCommit: config.upstreamCommit,
    autoEnable: config.autoEnable,
  };
  if (config.setupChecksum !== undefined) record.setupChecksum = config.setupChecksum;
  record.roles = config.roles;
  record.panels = config.panels;
  return stringifyYaml(record);
};

/**
 * Compute the setup checksum for a config: sha256 hex over the canonical
 * serialization of the config with the setupChecksum key removed.
 */
export const computeSetupChecksum = (config: PstackConfig): string => {
  const { setupChecksum: _ignored, ...withoutChecksum } = config;
  return sha256Hex(stringifyConfig(withoutChecksum));
};

/**
 * Verify a written config.yml against its embedded setupChecksum. Re-serializes
 * the parsed config minus the checksum key and compares hashes.
 */
export const verifySetupChecksum = (source: string): boolean => {
  let parsed: PstackConfig;
  try {
    parsed = parsePstackConfig(source);
  } catch {
    return false;
  }
  if (parsed.setupChecksum === undefined) return false;
  const { setupChecksum: expected, ...withoutChecksum } = parsed;
  return sha256Hex(stringifyConfig(withoutChecksum)) === expected;
};
