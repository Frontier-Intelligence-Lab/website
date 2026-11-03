// Manages external demo reviewer accounts in Postgres (reviewer_accounts). Never prints passwords or hashes.
//
//   node scripts/reviewers.js list
//   node scripts/reviewers.js import <reviewers.json>      # existing { username, name, role, passwordHash } entries
//   node scripts/reviewers.js set-password <username> --name "Display name" --role viewer|admin
//   node scripts/reviewers.js disable <username>
//   node scripts/reviewers.js enable <username>
//
// set-password reads the password from the terminal with echo off (or from stdin when piped), never from
// command arguments, so it does not end up in shell history or process listings.
// DATABASE_URL and DATABASE_SSL select the database, as for the web server.
import { readFileSync } from 'node:fs';
import { hashPassword } from '../src/lib/passwords.js';
import { normalizeUsername, parseReviewers } from '../src/lib/reviewers.js';
import { createPostgresStore } from '../src/store/postgres.js';

const ROLES = new Set(['viewer', 'admin']);
const USERNAME_RE = /^[a-z0-9._@+-]{1,64}$/;

function readSecret(prompt) {
  return new Promise((resolve, reject) => {
    const { stdin, stderr } = process;
    if (!stdin.isTTY) {
      let data = '';
      stdin.setEncoding('utf8').on('data', (c) => { data += c; }).on('end', () => resolve(data.split(/\r?\n/)[0])).on('error', reject);
      return;
    }
    stderr.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const onData = (ch) => {
      if (ch === '\r' || ch === '\n' || ch === '\u0004') {
        stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData); stderr.write('\n');
        resolve(value);
      } else if (ch === '\u0003') {
        stdin.setRawMode(false); stderr.write('\n'); process.exit(130);
      } else if (ch === '\u007f' || ch === '\b') {
        value = value.slice(0, -1);
      } else value += ch;
    };
    stdin.on('data', onData);
  });
}

function flag(args, name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL to the database to manage.');
  const ssl = process.env.DATABASE_SSL || (process.env.NODE_ENV === 'production' ? 'require' : 'disable');
  const store = createPostgresStore({ connectionString: process.env.DATABASE_URL, ssl });
  try {
    if (command === 'list') {
      for (const r of await store.listReviewers()) console.log(`${r.username}\t${r.role}\t${r.enabled ? 'enabled' : 'disabled'}\t${r.name}`);
    } else if (command === 'import') {
      if (!args[0]) throw new Error('Usage: import <reviewers.json>');
      // parseReviewers validates usernames, roles and scrypt hashes, and rejects duplicates.
      for (const r of parseReviewers(readFileSync(args[0], 'utf8'))) {
        await store.upsertReviewer(r);
        console.log(`imported ${r.username} (${r.role})`);
      }
    } else if (command === 'set-password') {
      const username = normalizeUsername(args[0]);
      const role = flag(args, 'role');
      const name = flag(args, 'name');
      if (!USERNAME_RE.test(username) || !ROLES.has(role) || !name) throw new Error('Usage: set-password <username> --name "Display name" --role viewer|admin');
      const password = await readSecret(`Password for ${username}: `);
      if (password.length < 12) throw new Error('Use at least 12 characters.');
      await store.upsertReviewer({ username, name, role, passwordHash: await hashPassword(password) });
      console.log(`set password for ${username} (${role})`);
    } else if (command === 'disable' || command === 'enable') {
      const r = await store.setReviewerEnabled({ username: normalizeUsername(args[0]), enabled: command === 'enable' });
      console.log(`${r.username} ${r.enabled ? 'enabled' : 'disabled'}`);
    } else {
      throw new Error('Commands: list | import <file> | set-password <username> --name … --role … | disable <username> | enable <username>');
    }
  } finally {
    await store.close();
  }
}

main().catch((err) => {
  // Database errors can carry connection details; print only the message we wrote or the error code.
  console.error(err.code ? `Failed (${err.code}).` : err.message);
  process.exitCode = 1;
});
