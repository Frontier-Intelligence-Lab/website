import nodemailer from 'nodemailer';

export const LIMITS = { name: 120, email: 254, organization: 160, message: 4000 };

// WHATWG HTML "valid e-mail address" pattern.
const EMAIL_RE = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

const text = (value) => (typeof value === 'string' ? value.trim() : '');

export function validateContact(rawBody) {
  // null, arrays and non-objects (e.g. a JSON "null" body) are treated as an empty submission.
  const body = rawBody && typeof rawBody === 'object' && !Array.isArray(rawBody) ? rawBody : {};
  const values = {
    name: text(body.name),
    email: text(body.email),
    organization: text(body.organization),
    message: text(body.message),
  };
  const errors = {};
  if (!values.name) errors.name = 'Please tell us your name.';
  else if (values.name.length > LIMITS.name) errors.name = `Please keep your name under ${LIMITS.name} characters.`;
  if (!values.email) errors.email = 'Please add an email address so we can reply.';
  else if (values.email.length > LIMITS.email || !EMAIL_RE.test(values.email)) errors.email = 'That email address does not look valid.';
  if (values.organization.length > LIMITS.organization) errors.organization = `Please keep this under ${LIMITS.organization} characters.`;
  if (!values.message) errors.message = 'Please write a short message.';
  else if (values.message.length > LIMITS.message) errors.message = `Please keep your message under ${LIMITS.message} characters.`;
  // Honeypot: real visitors never see or fill this field.
  if (text(body.website)) errors.form = 'The form could not be submitted.';
  return { values, errors, ok: Object.keys(errors).length === 0 };
}

/** Delivery is fail-closed: without SMTP configuration no message is accepted. */
export function createDelivery(smtp, transport = smtp ? createTransport(smtp) : null) {
  if (!smtp || !transport) {
    return { configured: false, async send() { throw new Error('Contact delivery is not configured'); } };
  }
  return {
    configured: true,
    verify: () => transport.verify(),
    async send(values, meta = {}) {
      const info = await transport.sendMail({
        from: smtp.from,
        to: smtp.to,
        replyTo: { name: values.name, address: values.email },
        subject: `Website contact from ${values.name}`,
        text: [
          `Name: ${values.name}`,
          `Email: ${values.email}`,
          `Organization: ${values.organization || '(not given)'}`,
          `Received: ${meta.receivedAt ?? new Date().toISOString()}`,
          '',
          values.message,
        ].join('\n'),
      });
      if (!info?.accepted?.length) throw new Error('Mail server did not accept the message');
      return info;
    },
  };
}

function createTransport(smtp) {
  return nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    requireTLS: !smtp.secure,
    auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
  });
}
