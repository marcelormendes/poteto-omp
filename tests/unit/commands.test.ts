import { expect, test } from "bun:test";
import { parseModeCommand, parseSetupArgs } from "../../src/extension/commands";

test("poteto-mode accepts the upstream entry point and preserves task text", () => {
  expect(parseModeCommand("")).toEqual({ action: "on" });
  expect(parseModeCommand(" STATUS ")).toEqual({ action: "status" });
  expect(parseModeCommand(" Fix FooBar without changing its API ")).toEqual({
    action: "task",
    task: "Fix FooBar without changing its API",
  });
});

test("setup handles quoted paths without passing quotes to the filesystem", () => {
  expect(parseSetupArgs('--file "/tmp/model choices.yml"')).toEqual({
    file: "/tmp/model choices.yml",
  });
  expect(parseSetupArgs("--file='/tmp/models.yml'")).toEqual({
    file: "/tmp/models.yml",
  });
  expect(parseSetupArgs("--file")).toHaveProperty("error");
});
