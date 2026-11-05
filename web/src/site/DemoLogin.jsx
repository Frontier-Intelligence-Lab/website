import { useState } from 'react';
import { Link, useLoaderData, useNavigate } from 'react-router';
import { api } from '../api.js';
import Field from './Field.jsx';

export default function DemoLogin() {
  const { signInConfigured } = useLoaderData();
  const navigate = useNavigate();
  const [error, setError] = useState(null);
  const [pending, setPending] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const res = await api.login(Object.fromEntries(new FormData(event.currentTarget))).catch(() => null);
    setPending(false);
    // The server names the destination: the real workspace when an entry is configured for this account, else the overview.
    if (res?.ok) return navigate(typeof res.data.to === 'string' && res.data.to.startsWith('/w/') ? res.data.to : '/demo/review');
    setError(res?.data.error ?? 'Sign-in failed. Please try again.');
  }

  return (
    <section className="narrow">
      <title>Demo login — Valcairn</title>
      <h1 className="headline">Reviewer sign-in.</h1>
      <p className="lede">Access is for invited reviewers only.</p>
      {!signInConfigured && (
        <p className="notice" role="status">Demo access is by invitation. <Link to="/contact">Contact us</Link> to request access.</p>
      )}
      {error && <p className="notice notice--error" role="alert">{error}</p>}
      <form onSubmit={submit} noValidate>
        <Field name="username" label="Username" autoComplete="username" autoCapitalize="none" spellCheck={false} maxLength={64} />
        <Field name="password" label="Password" type="password" autoComplete="current-password" maxLength={256} />
        <button className="btn btn-solid" type="submit" disabled={!signInConfigured || pending}>{pending ? 'Signing in…' : 'Sign in'}</button>
      </form>
      <p className="muted">Sign-ins are recorded (account name and time) so we know who has seen the demo.</p>
      <p className="muted">Need access or lost your invitation? <Link to="/contact">Contact us</Link>.</p>
    </section>
  );
}
