import { describe, expect, test } from "bun:test";
import { collectExtensionErrors } from "../e2e/assertions";

describe("collectExtensionErrors", () => {
  test("collects extension_error frames with their source line", () => {
    const errors = collectExtensionErrors([
      { type: "ready", protocolVersion: 1 },
      {
        type: "extension_error",
        extensionPath: "plugin:/pstack",
        event: "load",
        error: "boom",
      },
      { type: "response", command: "get_state", success: true },
    ]);
    expect(errors).toEqual([
      {
        extensionPath: "plugin:/pstack",
        event: "load",
        error: "boom",
        line: 1,
      },
    ]);
  });

  test("ignores non-error frames", () => {
    expect(
      collectExtensionErrors([
        { type: "extension_ui_request", id: "x" },
        null,
        42,
      ]),
    ).toEqual([]);
  });
});
