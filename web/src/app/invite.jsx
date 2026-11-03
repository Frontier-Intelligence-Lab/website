import { useState } from 'react';
import { Link, useLoaderData, useNavigate } from 'react-router';
import { api } from '../api.js';
import { SetupShell, Tile } from './ui.jsx';

const ROLE_NAMES = { owner: 'Owner', admin: 'Admin', member: 'Member', finance: 'Finance', viewer: 'Viewer' };

export async function inviteLoader({ params }) {
  const [res, account] = await Promise.all([api.invitation(params.token), api.account()]);
  return { token: params.token, invite: res.ok ? res.data : null, account };
}

export function Invite() {
  const { token, invite, account } = useLoaderData();
  const navigate = useNavigate();
  const [message, setMessage] = useState(null);
  const [pending, setPending] = useState(false);
  const here = `/invite/${token}`;
  const user = account.user;

  async function accept() {
    setPending(true);
    const res = await api.acceptInvitation(token).catch(() => null);
    setPending(false);
    if (res?.ok) return navigate(`/w/${res.data.workspaceSlug}`);
    setMessage(res?.data.error ?? 'Could not accept the invitation. Check your connection and try again.');
  }

  let body;
  if (!invite) {
    body = <><h1 className="ob-h1">This invitation link isn't valid</h1><p className="ob-lede">Check that you copied the whole link, or ask the person who invited you to send a new one.</p></>;
  } else if (invite.state !== 'valid') {
    const why = { used: 'has already been used', revoked: 'was withdrawn', expired: 'has expired' }[invite.state];
    body = <><h1 className="ob-h1">This invitation {why}</h1><p className="ob-lede">Ask someone at {invite.workspaceName} to invite you again.</p>{user && <Link className="btn-ghost" to="/start">Go to your workspaces</Link>}</>;
  } else {
    const summary = <p className="ob-lede">You're invited to join <strong>{invite.workspaceName}</strong> as <strong>{ROLE_NAMES[invite.role] ?? invite.role}</strong>. The invitation is for <strong>{invite.email}</strong>.</p>;
    if (!user) {
      body = <>
        <h1 className="ob-h1">Join {invite.workspaceName}</h1>{summary}
        <div className="ob-actions" style={{ justifyContent: 'flex-start' }}>
          <Link className="btn-app" to={`/signup?next=${encodeURIComponent(here)}&email=${encodeURIComponent(invite.email)}`}>Create an account</Link>
          <Link className="btn-ghost" to={`/signin?next=${encodeURIComponent(here)}&email=${encodeURIComponent(invite.email)}`}>I already have one</Link>
        </div>
      </>;
    } else if (user.email !== invite.email) {
      body = <>
        <h1 className="ob-h1">This invitation is for someone else</h1>{summary}
        <p className="ob-alert">You're signed in as {user.email}. Sign out and sign in as {invite.email} to accept it, or ask for an invitation to your own address.</p>
      </>;
    } else {
      body = <>
        <h1 className="ob-h1">Join {invite.workspaceName}</h1>{summary}
        {message && <p className="ob-alert" role="alert">{message}</p>}
        <div className="ob-actions" style={{ justifyContent: 'flex-start' }}>
          <button className="btn-app" type="button" disabled={pending} onClick={accept}>{pending ? 'Joining…' : `Join ${invite.workspaceName}`}</button>
          <Link className="btn-text" to="/start">Not now</Link>
        </div>
      </>;
    }
  }

  return (
    <SetupShell tone="amber" context="Invitation" status={null} exit={user ? { to: '/start', label: 'Your workspaces' } : { to: '/signin', label: 'Sign in' }}>
      <title>Invitation — Valcairn</title>
      <main className="ob-main ob-main--narrow">
        <Tile icon="mail" tone="amber" size="lg" />
        {body}
      </main>
    </SetupShell>
  );
}
