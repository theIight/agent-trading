import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BookmapImageRole } from '@wca/shared';

// Ảnh Bookmap đọc từ đường dẫn cấu hình ở server (Bookmap ghi đè file liên tục).
// Client không bao giờ gửi đường dẫn — chỉ đọc file trong cấu hình.

export const BOOKMAP_MAX_BYTES = 10 * 1024 * 1024;
const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };

/** `~/x` → `<home>/x`. */
export function expandHome(p: string): string {
  return p === '~' ? os.homedir() : p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}

export interface BookmapImageStatus {
  role: BookmapImageRole;
  available: boolean;
  /** Unix giây (mtime). */
  mtime?: number;
  size?: number;
  error?: string;
}

export interface BookmapImageFile {
  file: string;
  ext: string;
  mimeType: string;
  mtime: number;
}

/** Kiểm tra file ảnh: tồn tại, đúng định dạng, không quá lớn. */
export function inspectImage(file: string): BookmapImageFile | { error: string } {
  const ext = path.extname(file).toLowerCase();
  const mimeType = MIME[ext];
  if (!mimeType) return { error: `Chỉ hỗ trợ ảnh .png/.jpg: ${path.basename(file)}` };
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return { error: `Không tìm thấy ảnh: ${file}` };
  }
  if (!st.isFile()) return { error: `Không phải file: ${file}` };
  if (st.size > BOOKMAP_MAX_BYTES) return { error: `Ảnh quá lớn (${Math.round(st.size / 1024 / 1024)} MB > 10 MB): ${file}` };
  return { file, ext: ext === '.jpeg' ? '.jpg' : ext, mimeType, mtime: Math.floor(st.mtimeMs / 1000) };
}

export function imageStatus(role: BookmapImageRole, file: string | undefined): BookmapImageStatus {
  if (!file) return { role, available: false, error: 'Chưa cấu hình đường dẫn' };
  const r = inspectImage(file);
  if ('error' in r) return { role, available: false, error: r.error };
  return { role, available: true, mtime: r.mtime, size: fs.statSync(file).size };
}
