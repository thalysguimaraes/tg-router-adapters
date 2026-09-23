/** Count only schemas exposed to this agent, not the inactive tool registry.
 * If runtime metadata is incomplete, retain the conservative full registry.
 * This changes accounting only; it never changes tools or conversation history.
 */
export function contextTools<T extends { name: string }>(all: T[], active: unknown): T[] {
  if (!Array.isArray(active) || active.some(name => typeof name !== 'string')) return all;
  const names = new Set(active as string[]);
  const registered = new Set(all.map(tool => tool.name));
  if ([...names].some(name => !registered.has(name))) return all;
  return all.filter(tool => names.has(tool.name));
}
