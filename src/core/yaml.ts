/**
 * Typed YAML parsing and atomic writes for pstack files.
 *
 * Parse failures become PstackError(PSTACK_CONFIG_PARSE) so callers can fail
 * closed instead of spreading raw strings. Writes are content-addressed
 * renames: a crash mid-write leaves the previous file intact.
 */
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parse as parseYamlText, stringify as stringifyYamlText } from "yaml";
import { PstackError } from "./errors";

/** Parse YAML text; any syntax error becomes a stable PstackError. */
export const parseYaml = (source: string, sourceName = "pstack config"): unknown => {
  try {
    return parseYamlText(source);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new PstackError("PSTACK_CONFIG_PARSE", `Failed to parse ${sourceName}: ${detail}`);
  }
};

/** Serialize a value as YAML text. */
export const stringifyYaml = (value: unknown): string => stringifyYamlText(value);

/**
 * Read and parse a YAML file. Returns undefined when the file is absent
 * (ENOENT); any other read error or parse error is thrown.
 */
export const readYamlFile = async (path: string): Promise<unknown | undefined> => {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return parseYaml(source, path);
};

/**
 * Write a YAML file atomically: create the parent directory, write a sibling
 * temp file, then rename over the destination.
 */
export const writeYamlFile = async (path: string, value: unknown): Promise<void> => {
  const serialized = stringifyYaml(value);
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(tempPath, serialized, "utf8");
    await rename(tempPath, path);
  } catch (error) {
    await unlink(tempPath).catch(() => {});
    throw error;
  }
};
