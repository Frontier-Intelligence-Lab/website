import { useState } from 'react';
import { Link, redirect, useLoaderData, useLocation, useNavigate } from 'react-router';
import { api } from '../api.js';
import { ThemeToggle } from '../theme.jsx';
import { FieldError, Tile, nextPath } from './ui.jsx';

const PERSONAL = ['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'yahoo.com', 'icloud.com', 'me.com', 'proton.me', 'protonmail.com', 'aol.com'];

function emailHint(email) {
  const domain = email.split('@')[1]?.toLowerCase() ?? '';
  if (!domain.includes('.')) return { tone: 'plain', text: 'Use a work email to find your team faster.' };
  if (PERSONAL.includes(domain)) return { tone: 'violet', text: 'Personal email. Fine for a personal workspace, and you can still create an organization.' };
  if (/\.(edu|ac\.[a-z]{2})$/.test(domain)) return { tone: 'violet', text: 'Academic email. You can verify it later for research-only datasets.' };
  return { tone: 'blue', text: `Work email. After you confirm it, we check whether ${domain} already has an organization here.` };
}

function AuthLayout({ children }) {
  return (
    <div className="ob ob-split">
      <section className="ob-split-side">
        <div className="ob-brand">
          <span className="dash-mark" aria-hidden="true" />
          <strong>Valcairn</strong>
          <small>by Frontier Intelligence Labs</small>
          <span style={{ marginLeft: 'auto' }}><ThemeToggle /></span>
        </div>
        <div className="ob-intro">
          <h2>Build AI your team controls.</h2>
          <p className="ob-lede">Bring the task and the data. Leave with a model you can run, test and improve, with a clear record of the rights to everything it learned from.</p>
        </div>
        <ul className="ob-features">
          <li><Tile icon="data" tone="orange" /><div><strong>Data with its rights attached</strong><span className="ob-muted">Your own, licensed or newly collected.</span></div></li>
          <li><Tile icon="layers" tone="blue" /><div><strong>Models tested on your task</strong><span className="ob-muted">Against a bar you set before training.</span></div></li>
          <li><Tile icon="bank" tone="amber" /><div><strong>Financing for growth (planned)</strong><span className="ob-muted">For compute, equipment and rollouts. Not available yet.</span></div></li>
        </ul>
      </section>
      <main className="ob-split-main">{children}</main>
    </div>
  );
}

// Only same-site paths may be used as a post-sign-in destination.
const safeNext = (value) => (typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') ? value : null);
const params = (request) => new URL(request.url).searchParams;

export async function signUpLoader({ request }) {
  const account = await api.account();
  const next = safeNext(params(request).get('next'));
  if (account.user) throw redirect(next ?? nextPath(account));
  return { ...account, next, email: params(request).get('email') ?? '' };
}

export function SignUp() {
  const { signupOpen, next, email: invitedEmail } = useLoaderData();
  const navigate = useNavigate();
  const [email, setEmail] = useState(invitedEmail);
  const [errors, setErrors] = useState({});
  const [message, setMessage] = useState(null);
  const [pending, setPending] = useState(false);
  const hint = emailHint(email);

  async function submit(event) {
    event.preventDefault();
    setPending(true);
    const res = await api.signup(Object.fromEntries(new FormData(event.currentTarget))).catch(() => null);
    setPending(false);
    if (res?.ok) return navigate('/verify', { state: { devCode: res.data.devCode, next } });
    setErrors(res?.data.errors ?? {});
    setMessage(res?.data.error ?? 'Sign-up failed. Please try again.');
  }

  return (
    <AuthLayout>
      <title>Create your account — Valcairn</title>
      <form className="ob-form" onSubmit={submit} noValidate>
        <div className="ob-intro">
          <h1 className="ob-h1">Create your account</h1>
          <p className="ob-muted">Already have one? <Link to={next ? `/signin?next=${encodeURIComponent(next)}` : '/signin'}>Sign in</Link></p>
        </div>
        {!signupOpen && <p className="ob-alert" role="status">New accounts aren't open yet. <Link to="/contact">Contact us</Link> for access.</p>}
        {message && <p className="ob-alert" role="alert">{message}</p>}
        <div className="ob-field">
          <label htmlFor="name">Full name</label>
          <input id="name" name="name" type="text" autoComplete="name" maxLength={120} aria-invalid={errors.name ? true : undefined} aria-describedby="name-error" />
          <FieldError id="name-error">{errors.name}</FieldError>
        </div>
        <div className="ob-field">
          <label htmlFor="email">Email</label>
          <input id="email" name="email" type="email" autoComplete="email" maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} aria-invalid={errors.email ? true : undefined} aria-describedby="email-hint email-error" />
          <p id="email-hint" className={`ob-note tile--${hint.tone}`}>{hint.text}</p>
          <FieldError id="email-error">{errors.email}</FieldError>
        </div>
        <div className="ob-field">
          <label htmlFor="password">Password</label>
          <input id="password" name="password" type="password" autoComplete="new-password" minLength={10} maxLength={256} aria-invalid={errors.password ? true : undefined} aria-describedby="password-error" />
          <FieldError id="password-error">{errors.password ?? <span className="ob-muted">At least 10 characters.</span>}</FieldError>
        </div>
        <button className="btn-app btn-block" type="submit" disabled={!signupOpen || pending}>{pending ? 'Creating account…' : 'Continue'}</button>
        <p className="ob-muted">We'll email a 6-digit code to confirm it's you.</p>
      </form>
    </AuthLayout>
  );
}

export async function signInLoader({ request }) {
  const account = await api.account();
  const next = safeNext(params(request).get('next'));
  if (account.user) throw redirect(next ?? nextPath(account));
  return { next, email: params(request).get('email') ?? '' };
}

export function SignIn() {
  const { next, email } = useLoaderData();
  const navigate = useNavigate();
  const [message, setMessage] = useState(null);
  const [pending, setPending] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setPending(true);
    const res = await api.signin(Object.fromEntries(new FormData(event.currentTarget))).catch(() => null);
    setPending(false);
    if (!res?.ok) return setMessage(res?.data.error ?? 'Sign-in failed. Please try again.');
    const account = await api.account();
    return navigate(next && account.user.emailVerifiedAt ? next : nextPath(account), { state: { next } });
  }

  return (
    <AuthLayout>
      <title>Sign in — Valcairn</title>
      <form className="ob-form" onSubmit={submit} noValidate>
        <div className="ob-intro">
          <h1 className="ob-h1">Sign in</h1>
          <p className="ob-muted">New here? <Link to={next ? `/signup?next=${encodeURIComponent(next)}` : '/signup'}>Create an account</Link></p>
        </div>
        {message && <p className="ob-alert" role="alert">{message}</p>}
        <div className="ob-field"><label htmlFor="email">Email</label><input id="email" name="email" type="email" autoComplete="email" maxLength={254} defaultValue={email} /></div>
        <div className="ob-field"><label htmlFor="password">Password</label><input id="password" name="password" type="password" autoComplete="current-password" maxLength={256} /></div>
        <button className="btn-app btn-block" type="submit" disabled={pending}>{pending ? 'Signing in…' : 'Sign in'}</button>
        <p className="ob-muted">Invited reviewers use the <Link to="/demo">demo login</Link> instead.</p>
      </form>
    </AuthLayout>
  );
}

export async function verifyLoader() {
  const account = await api.account();
  if (!account.user) throw redirect('/signup');
  if (account.user.emailVerifiedAt) throw redirect(nextPath(account));
  return account;
}

export function Verify() {
  const { user } = useLoaderData();
  const navigate = useNavigate();
  const location = useLocation();
  const [devCode, setDevCode] = useState(location.state?.devCode ?? null);
  const [message, setMessage] = useState(null);
  const [notice, setNotice] = useState(null);
  const [pending, setPending] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setPending(true);
    const res = await api.verify(new FormData(event.currentTarget).get('code')).catch(() => null);
    setPending(false);
    const next = safeNext(location.state?.next);
    if (res?.ok) return navigate(next ?? (res.data.match ? '/setup/match' : '/start'));
    setMessage(res?.data.error ?? 'That did not work. Please try again.');
  }

  async function resend() {
    const res = await api.resendCode().catch(() => null);
    if (res?.ok) {
      setDevCode(res.data.devCode ?? null);
      setNotice('We sent a new code.');
      setMessage(null);
    } else setMessage(res?.data.error ?? 'Could not send a new code.');
  }

  return (
    <AuthLayout>
      <title>Confirm your email — Valcairn</title>
      <form className="ob-form" onSubmit={submit} noValidate>
        <div className="ob-intro">
          <Tile icon="mail" tone="blue" size="lg" />
          <h1 className="ob-h1">Check your email</h1>
          <p className="ob-lede">We sent a 6-digit code to <strong>{user.email}</strong>. It expires in 15 minutes.</p>
        </div>
        {devCode && <p className="ob-alert ob-alert--info" role="status">Local development: email isn't configured, so your code is <strong>{devCode}</strong>.</p>}
        {notice && <p className="ob-alert ob-alert--ok" role="status">{notice}</p>}
        {message && <p className="ob-alert" role="alert">{message}</p>}
        <div className="ob-field">
          <label htmlFor="code">Confirmation code</label>
          <input id="code" name="code" type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6} className="ob-code" />
        </div>
        <button className="btn-app btn-block" type="submit" disabled={pending}>{pending ? 'Checking…' : 'Confirm email'}</button>
        <p className="ob-muted">No email? <button type="button" className="btn-text" onClick={resend}>Send a new code</button></p>
      </form>
    </AuthLayout>
  );
}
