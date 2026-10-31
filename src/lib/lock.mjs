// Single-run lock (data/run.lock) with pid-based stale detection (PLAN §1).
import fs from 'node:fs';
import path from 'node:path';

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

export class LockBusyError extends Error {
  constructor(holder) { super(`another run holds the lock (pid ${holder?.pid}, since ${holder?.at})`); this.name = 'LockBusyError'; this.holder = holder; }
}

const YOUNG_MS = 60 * 1000;

/**
 * Atomic acquisition (BUG-009): the lock content is written to a private temp file first and then hard-linked into place
 * (link() fails with EEXIST if the lock exists), so a lock file is never visible empty or half-written. An unparseable lock
 * younger than 60 s is treated as held; a stale lock is moved aside atomically and re-checked before it is discarded.
 */
export function acquireLock(file, { staleMs = 3 * 3600 * 1000, pid = process.pid } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = JSON.stringify({ pid, at: new Date().toISOString() });
  const release = () => { try { const cur = JSON.parse(fs.readFileSync(file, 'utf8')); if (cur.pid === pid) fs.unlinkSync(file); } catch { /* gone */ } };
  for (let i = 0; i < 3; i++) {
    const tmp = `${file}.${pid}.${process.hrtime.bigint()}.tmp`;
    fs.writeFileSync(tmp, body, { flag: 'wx' });
    try { fs.linkSync(tmp, file); return { release }; }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
    finally { fs.rmSync(tmp, { force: true }); }
    let text = null, holder = null, mtime = 0;
    try { text = fs.readFileSync(file, 'utf8'); mtime = fs.statSync(file).mtimeMs; } catch { continue; } // vanished: retry
    try { holder = JSON.parse(text); } catch { /* unparseable */ }
    if (!holder) { if (Date.now() - mtime < YOUNG_MS) throw new LockBusyError({ pid: null, at: new Date(mtime).toISOString() }); }
    else if (alive(holder.pid) && Date.now() - Date.parse(holder.at) <= staleMs) throw new LockBusyError(holder);
    const aside = `${file}.stale.${pid}.${process.hrtime.bigint()}`;
    try { fs.renameSync(file, aside); } catch { continue; }
    let moved = null;
    try { moved = fs.readFileSync(aside, 'utf8'); } catch { /* ignore */ }
    if (moved !== text) { try { fs.linkSync(aside, file); } catch { /* someone else holds it now */ } fs.rmSync(aside, { force: true }); throw new LockBusyError(null); }
    fs.rmSync(aside, { force: true });
  }
  throw new LockBusyError(null);
}
