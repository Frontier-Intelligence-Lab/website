import { useEffect, useRef, useState } from 'react';
import { useLoaderData } from 'react-router';
import { api } from '../api.js';
import Field from './Field.jsx';

export default function Contact() {
  const { bookingUrl, contactEmail, contactConfigured, limits } = useLoaderData();
  const [errors, setErrors] = useState({});
  const [failure, setFailure] = useState(null);
  const [status, setStatus] = useState('idle');
  const formRef = useRef(null);

  // Move focus to the first invalid field after a rejected submission.
  useEffect(() => { formRef.current?.querySelector('[aria-invalid="true"]')?.focus(); }, [errors]);

  async function submit(event) {
    event.preventDefault();
    setStatus('sending');
    setFailure(null);
    const res = await api.contact(Object.fromEntries(new FormData(event.currentTarget))).catch(() => null);
    if (res?.ok) return setStatus('sent');
    setStatus('idle');
    setErrors(res?.data.errors ?? {});
    if (res?.status !== 400 || res.data.errors?.form) setFailure(res?.data.error ?? 'We could not send your message right now. Please try again later.');
  }

  const email = <a href={`mailto:${contactEmail}`}>{contactEmail}</a>;
  return (
    <section className="split">
      <title>Contact — Valcairn</title>
      <div>
        <h1 className="headline">Let's talk.</h1>
        <p className="lede">Tell us a little about yourself and what you have in mind. We read every message and reply personally.</p>
        <p><a className="btn btn-solid" href={bookingUrl} rel="noopener">Book a 15-minute call</a></p>
        <p className="muted">Or email {email}.</p>
      </div>
      <div>
        {status === 'sent' ? (
          <div className="notice notice--ok" role="status">
            <h2>Thank you.</h2>
            <p>Your message was accepted for delivery to our inbox. We will reply by email.</p>
          </div>
        ) : (
          <>
            {!contactConfigured && (
              <p className="notice" role="status">Message delivery is not configured on this deployment yet. Please book a call or email {email} instead.</p>
            )}
            {failure && <p className="notice notice--error" role="alert">{failure}</p>}
            <form ref={formRef} onSubmit={submit} noValidate>
              <Field name="name" label="Name" autoComplete="name" maxLength={limits.name} error={errors.name} />
              <Field name="email" label="Email" type="email" autoComplete="email" maxLength={limits.email} error={errors.email} />
              <Field name="organization" label="Organization" optional autoComplete="organization" maxLength={limits.organization} error={errors.organization} />
              <Field name="message" label="Message" textarea maxLength={limits.message} error={errors.message} />
              <div className="trap" aria-hidden="true">
                <label htmlFor="website">Website</label>
                <input id="website" name="website" type="text" tabIndex={-1} autoComplete="off" />
              </div>
              <button className="btn btn-solid" type="submit" disabled={!contactConfigured || status === 'sending'}>
                {status === 'sending' ? 'Sending…' : 'Send message'}
              </button>
            </form>
          </>
        )}
      </div>
    </section>
  );
}
