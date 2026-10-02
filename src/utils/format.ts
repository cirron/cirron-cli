/**
 * Render a byte count for human display.
 *
 * Bytes and KB get one decimal, MB and GB two. Matches what push/pull have
 * always printed; the divergent `formatBytes` variants in build/doctor/replay
 * are deliberately NOT unified here because their output differs.
 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
