// Prints a reviewer entry for REVIEWERS_FILE / REVIEWERS_JSON.
// Usage:  node scripts/hash-password.js [--admin] --generate <username> "Display Name"
//         echo "chosen-password" | node scripts/hash-password.js [--admin] <username> "Display Name"
// --admin lets the account read the sign-in log; everyone else is a viewer.
import { randomBytes } from 'node:crypto';
import { hashPassword } from '../src/lib/passwords.js';
import { normalizeUsername } from '../src/lib/reviewers.js';

const args = process.argv.slice(2);
const generate = args.includes('--generate');
const role = args.includes('--admin') ? 'admin' : 'viewer';
const [username = 'reviewer', name = username] = args.filter((a) => !a.startsWith('--'));

let password;
if (generate) {
  password = randomBytes(15).toString('base64url');
} else {
  password = (await new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8').on('data', (c) => { data += c; }).on('end', () => resolve(data));
  })).split(/\r?\n/)[0];
}
if (!password || password.length < 8) {
  console.error('Provide a password of at least 8 characters on stdin, or pass --generate.');
  process.exit(1);
}
if (password.length < 15) console.error('Warning: passwords under 15 characters are easier to guess; consider a longer one.');

const entry = { username: normalizeUsername(username), name, role, passwordHash: await hashPassword(password) };
if (generate) console.error(`Generated password (share privately, it is not stored): ${password}`);
console.log(JSON.stringify(entry, null, 2));
