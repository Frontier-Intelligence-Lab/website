import { appendFile, readFile } from 'node:fs/promises';

const KEEP = 200;

/**
 * Sign-in history: who signed in or out, and failed attempts against real accounts.
 * Always kept in memory (latest 200); also appended as JSON Lines to `file` when set,
 * so it survives restarts. Unknown usernames are never stored, since people sometimes
 * type a password into the username field.
 */
export async function createSigninLog(file, log) {
  let events = [];
  if (file) {
    try {
      events = (await readFile(file, 'utf8')).split('\n').filter(Boolean).flatMap((line) => {
        try { return [JSON.parse(line)]; } catch { return []; }
      }).slice(-KEEP);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  return {
    async record(event) {
      const entry = { at: new Date().toISOString(), ...event };
      events = [...events.slice(-(KEEP - 1)), entry];
      if (file) await appendFile(file, `${JSON.stringify(entry)}\n`).catch((err) => log?.error({ err }, 'sign-in log write failed'));
      return entry;
    },
    recent: () => events.toReversed(),
  };
}
