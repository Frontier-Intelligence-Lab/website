import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'services', 'research');
const STDOUT_CAP = 2 * 1024 * 1024;
const KEEP = ['PATH', 'PATHEXT', 'SYSTEMROOT', 'COMSPEC', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'LANG', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES'];

/** Environment for the worker: enough to start Python, and no database, mail or API secrets. */
export function researchWorkerEnv(base = process.env) {
  const env = { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };
  for (const key of KEEP) if (base[key]) env[key] = base[key];
  return env;
}

/**
 * Spawn `python -m valcairn_research` for one run. The child receives the question,
 * https URLs and an optional Wikimedia flag. It does not receive a shell or credentials.
 */
export function createResearchWorker({ python = process.env.RESEARCH_PYTHON || 'python', cwd = ROOT, timeoutMs = 20000, env = researchWorkerEnv() } = {}) {
  return function researchExecutor(payload) {
    const body = JSON.stringify({
      question: typeof payload.question === 'string' ? payload.question : '',
      urls: Array.isArray(payload.urls) ? payload.urls.filter((url) => typeof url === 'string').slice(0, 5) : [],
      search: payload.search === 'wikimedia' ? 'wikimedia' : 'none',
      limits: { maxUrls: Number.isInteger(payload.limits?.maxUrls) ? payload.limits.maxUrls : 3 },
    });
    return new Promise((resolve, reject) => {
      const child = spawn(python, ['-m', 'valcairn_research'], { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let settled = false;
      let timer;
      const finish = (err, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve(value);
      };
      timer = setTimeout(() => {
        child.kill();
        finish(new Error('The research worker timed out before a report was stored.'));
      }, timeoutMs);
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
        if (stdout.length > STDOUT_CAP) {
          child.kill();
          finish(new Error('The research worker returned more text than this run allows.'));
        }
      });
      child.stderr.on('data', () => {});
      child.on('error', (err) => {
        const missing = err?.code === 'ENOENT';
        finish(new Error(missing
          ? 'The research worker could not be started. Set RESEARCH_PYTHON to a Python 3.11+ executable. Nothing was fetched.'
          : 'The research worker could not be started. Nothing was fetched.'));
      });
      child.on('close', (code) => {
        if (settled) return;
        if (code !== 0) return finish(new Error('The research worker stopped without a report.'));
        try {
          const parsed = JSON.parse(stdout);
          if (!parsed || !Array.isArray(parsed.pages)) return finish(new Error('The research worker did not return a report.'));
          finish(null, parsed);
        } catch {
          finish(new Error('The research worker did not return a report.'));
        }
      });
      try { child.stdin.end(body); } catch { /* the error event settles the promise */ }
    });
  };
}
