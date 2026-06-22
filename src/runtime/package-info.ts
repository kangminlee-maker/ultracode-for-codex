import { readFileSync } from 'node:fs';

let cachedPackageVersion: string | undefined;

export function ultracodePackageVersion(): string {
  if (cachedPackageVersion) return cachedPackageVersion;
  const packageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
    readonly version?: unknown;
  };
  if (typeof packageJson.version !== 'string' || !packageJson.version.trim()) {
    throw new Error('Package version is missing from package.json.');
  }
  cachedPackageVersion = packageJson.version;
  return cachedPackageVersion;
}
