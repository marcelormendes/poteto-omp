export const parseModeCommand = (
  args: string,
): { action: "on" | "off" | "status" } | { action: "task"; task: string } => {
  const task = args.trim();
  const action = task.toLowerCase();
  if (action === "") return { action: "on" };
  if (action === "on" || action === "off" || action === "status")
    return { action };
  return { action: "task", task };
};

export const parseSetupArgs = (
  args: string,
): { file?: string } | { error: string } => {
  const trimmed = args.trim();
  if (!trimmed) return {};
  const match = /^--file(?:=|\s+)(.+)$/.exec(trimmed);
  if (!match) return { error: "Usage: /setup-pstack [--file models.yml]" };
  const value = match[1]!.trim();
  const file = /^(".*"|'.*')$/.test(value) ? value.slice(1, -1) : value;
  return file ? { file } : { error: "--file requires a path" };
};
