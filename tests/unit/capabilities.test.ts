import { expect, test } from "bun:test";
import { TASK_SETTINGS, checkTaskCapabilities } from "../../src/extension/capabilities";
const settings = {...TASK_SETTINGS, "task.maxConcurrency": 2, "task.maxRecursionDepth": 2};
test("small local worker budgets work; async batches may be disabled", () => {
  expect(checkTaskCapabilities(key => settings[key])).toEqual([]);
  expect(checkTaskCapabilities(key => key === "task.maxConcurrency" ? 0 : settings[key])).toEqual([]);
});
test("automatic patch application is unsafe for competing arena candidates", () => {
  expect(checkTaskCapabilities(key => key === "task.isolation.apply" ? true : settings[key])).toMatchObject([{key: "task.isolation.apply", actual: "true"}]);
});
test("missing settings and disabled delegation are reported", () => {
  expect(checkTaskCapabilities(() => undefined)).toHaveLength(5);
  expect(checkTaskCapabilities(key => key === "task.maxRecursionDepth" ? 0 : settings[key])).toMatchObject([{key:"task.maxRecursionDepth"}]);
});
