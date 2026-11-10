import path from 'node:path';

/** Thư mục gốc của monorepo (apps/server/src → ../../..). */
export const ROOT = path.resolve(import.meta.dirname, '../../..');

export function fromRoot(p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(ROOT, p);
}
