export function isWithinJsonLimits(
  input: unknown,
  { maxDepth = 32, maxNodes = 20000 }: { maxDepth?: number; maxNodes?: number } = {},
): boolean {
  const stack: Array<{ value: unknown; depth: number }> = [{ value: input, depth: 0 }];
  const seen = new WeakSet<object>();
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > maxNodes || current.depth > maxDepth) return false;
    if (typeof current.value !== "object" || current.value === null) continue;
    if (seen.has(current.value)) return false;
    seen.add(current.value);
    const values = Array.isArray(current.value) ? current.value : Object.values(current.value);
    if (nodes + values.length > maxNodes) return false;
    for (const value of values) stack.push({ value, depth: current.depth + 1 });
  }
  return true;
}
