import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'services', 'research');
const STDOUT_CAP = 2 * 1024 * 1024;
const KEEP = ['PATH', 'PATHEXT', 'SYSTEMROOT', 'COMSPEC', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'LANG', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES'];

/** Environment for the worker: enough to start Python, and no database, mail or API secrets. */
export function researchWorkerEnv(base = process.env) {
  const env = { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };
  for (const key of KEEP) if (base[key]) env[key] = base[key];
  return env;
}

const MESSAGES = Object.freeze({
  worker_unavailable: 'The research worker could not be started. Set RESEARCH_PYTHON to a Python 3.11+ executable. Nothing was fetched.',
  worker_start: 'The research worker could not be started. Nothing was fetched.',
  worker_timeout: 'The research worker timed out before a report was stored.',
  worker_large: 'The research worker returned more text than this run allows.',
  worker_report: 'The research worker did not return a report.',
  worker_stopped: 'The research worker stopped without a report.',
  worker_cancelled: 'Cancelled before a report was stored.',
});
const failure = (code) => Object.assign(new Error(MESSAGES[code]), { code });
export const researchWorkerMessage = (error) => MESSAGES[error?.code] ?? 'The research worker failed before a report was stored. Check its configuration and try again.';

/** Spawn one bounded worker. Aborting kills it and observes late pipe/process errors. */
export function createResearchWorker({ python = process.env.RESEARCH_PYTHON || 'python', cwd = ROOT, timeoutMs = 20000, env = researchWorkerEnv(), spawnProcess = spawn } = {}) {
  return function researchExecutor(payload, { signal } = {}) {
    if (signal?.aborted) return Promise.reject(failure('worker_cancelled'));
    const body = JSON.stringify({
      question: typeof payload.question === 'string' ? payload.question : '',
      urls: Array.isArray(payload.urls) ? payload.urls.filter((url) => typeof url === 'string').slice(0, 5) : [],
      search: payload.search === 'wikimedia' ? 'wikimedia' : 'none',
      limits: { maxUrls: Number.isInteger(payload.limits?.maxUrls) ? payload.limits.maxUrls : 3 },
    });
    return new Promise((resolve, reject) => {
      const child = spawnProcess(python, ['-m', 'valcairn_research'], { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stdoutBytes = 0;
      const decoder = new StringDecoder('utf8');
      let settled = false;
      let timer;
      const finish = (err, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (err) reject(err);
        else resolve(value);
      };
      const stop = (code) => {
        if (settled) return;
        child.kill();
        finish(failure(code));
      };
      const abort = () => stop('worker_cancelled');
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => stop('worker_timeout'), timeoutMs);
      child.stdout.on('data', (chunk) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        stdoutBytes += bytes.length;
        if (stdoutBytes > STDOUT_CAP) stop('worker_large');
        else stdout += decoder.write(bytes);
      });
      child.stderr.on('data', () => {});
      child.stdin.on('error', () => stop('worker_stopped'));
      child.on('error', (err) => finish(failure(err?.code === 'ENOENT' ? 'worker_unavailable' : 'worker_start')));
      child.on('close', (code) => {
        if (settled) return;
        if (code !== 0) return finish(failure('worker_stopped'));
        try {
          stdout += decoder.end();
          const parsed = JSON.parse(stdout);
          if (!parsed || !Array.isArray(parsed.pages)) return finish(failure('worker_report'));
          finish(null, parsed);
        } catch { finish(failure('worker_report')); }
      });
      if (signal?.aborted) abort();
      else {
        try { child.stdin.end(body); }
        catch { stop('worker_stopped'); }
      }
    });
  };
}
