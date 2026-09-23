/** The project's single canonical object guard. One definition, imported everywhere. */
export function isObjectGuard(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
