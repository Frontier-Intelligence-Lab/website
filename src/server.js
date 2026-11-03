import { loadConfig } from './config.js';
import { buildApp } from './app.js';

const config = loadConfig();
const app = await buildApp({ config, logger: { level: config.logLevel } });

app.log.info({
  contactDelivery: config.contactDelivery,
  reviewersConfigured: config.reviewers.length,
  cookieSecure: config.cookieSecure,
  trustProxy: config.trustProxy,
}, 'valcairn site starting');

if (app.delivery.configured) {
  app.delivery.verify().then(
    () => app.log.info('SMTP connection verified'),
    (err) => app.log.error({ err: err.message }, 'SMTP verification failed; contact submissions will fail until fixed'),
  );
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => app.close().then(() => process.exit(0)));
}

await app.listen({ port: config.port, host: config.host });
