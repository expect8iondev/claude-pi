/**
 * Shared output helper — JSON to stdout, errors to stderr + exit 1.
 * Matches gcop's contract exactly.
 */
export function output(result: Record<string, unknown>): void {
  const json = JSON.stringify(result, null, 2);
  if (result.status === "error") {
    process.stderr.write(json + "\n");
    process.exit(1);
  }
  process.stdout.write(json + "\n");
}
