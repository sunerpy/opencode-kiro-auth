// Type declarations for the benchmark env-isolation module (pure JS, dev-only).
export function realConfigDir(): string
export function seedModeEnv(
  baseRoot: string,
  mode: string,
  sharedDbFiles: Array<[string, string]>,
  workerCount: number,
  repoRoot: string
): {
  xdgConfig: string
  workerDataDirs: string[]
  projectDir: string
  opencodeConfigDir: string
}
