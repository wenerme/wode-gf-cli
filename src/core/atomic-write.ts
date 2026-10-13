import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Replace `file` atomically, refusing if it changed on disk since it was read as `expectedOriginal`.
 * Symlinks are resolved so the link itself is kept; the temp file is created exclusively.
 */
export function writeFileAtomic(file: string, content: string, expectedOriginal: string) {
  const target = fs.realpathSync(file);
  if (fs.readFileSync(target, "utf8") !== expectedOriginal) {
    throw new Error(`${file} changed on disk while it was being edited; re-run against the latest content`);
  }
  const temp = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${randomBytes(6).toString("hex")}.tmp`,
  );
  fs.writeFileSync(temp, content, { encoding: "utf8", mode: fs.statSync(target).mode, flag: "wx" });
  try {
    fs.renameSync(temp, target);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}
