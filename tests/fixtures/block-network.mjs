// Test preload (node --import): every outbound connection or name lookup in the process fails at once with one
// sentinel, before any socket is opened or any resolver asked. Used around the demo seed so a refusal is proven to
// happen with no network activity at all, and so a run that got past the guard could never reach a database.
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';

export const SENTINEL = 'VALCAIRN_TEST_NETWORK_BLOCKED';
const blocked = () => Object.assign(new Error(SENTINEL), { code: 'EBLOCKED_BY_TEST' });
const refuse = () => { throw blocked(); };

net.Socket.prototype.connect = refuse;
net.connect = refuse;
net.createConnection = refuse;
tls.connect = refuse;
for (const name of ['lookup', 'resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCname', 'resolveSrv', 'resolveTxt', 'reverse']) {
  dns[name] = (...args) => { const callback = args.at(-1); if (typeof callback === 'function') callback(blocked()); else throw blocked(); };
  dns.promises[name] = async () => { throw blocked(); };
}
