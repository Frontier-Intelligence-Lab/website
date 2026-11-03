import { useState } from 'react';
import { Link, redirect, useLoaderData, useNavigate } from 'react-router';
import { api } from '../api.js';
import { FieldError, Icon, SetupShell, Tile, initials, requireVerified, requireWorkspace } from './ui.jsx';

const PERSONAL = ['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'yahoo.com', 'icloud.com', 'me.com', 'proton.me', 'protonmail.com', 'aol.com'];
const domainOf = (email) => email.split('@')[1]?.toLowerCase() ?? '';
const slugify = (value) => value.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);

export async function startLoader() {
  const account = await requireVerified();
  if (account.match) throw redirect('/setup/match');
  return account;
}

export function Start() {
  const { user, workspaces, joinRequests } = useLoaderData();
  const work = !PERSONAL.includes(domainOf(user.email));
  return (
    <SetupShell context={user.email} status={null} exit={workspaces[0] ? { to: `/w/${workspaces[0].slug}`, label: 'Back to workspace' } : null}>
      <title>How will you use Valcairn? — Valcairn</title>
      <main className="ob-main" style={{ flexDirection: 'column', alignItems: 'stretch', maxWidth: 1120, paddingTop: 56 }}>
        <div className="ob-intro">
          <span className="ob-eyebrow">Welcome, {user.name.split(' ')[0]}</span>
          <h1 className="ob-h1 ob-h1--xl">How will you use Valcairn?</h1>
          <p className="ob-lede">This decides who owns your workspace and what it can do. You can join or create others later.</p>
        </div>
        {joinRequests.map((r) => (
          <p key={r.id} className="ob-alert ob-alert--info" role="status">Your request to join <strong>{r.workspaceName}</strong> is waiting for an admin. We'll let you in as soon as it's approved.</p>
        ))}
        <div className="ob-doors">
          <Link to="/setup/organization" className={`ob-door${work ? ' ob-door--suggested' : ''}`}>
            <span className="ob-door-head"><Tile icon="building" tone="blue" size="lg" />{work && <span className="ob-badge tile--blue">Suggested for your email</span>}</span>
            <span className="ob-door-title">For my company or team</span>
            <p>Create an organization. Colleagues share projects, data and models, each with their own role.</p>
            <span className="ob-door-foot">Commercial licenses, spend approvals and financing need an organization.</span>
          </Link>
          <Link to="/setup/personal" className={`ob-door${work ? '' : ' ob-door--suggested'}`}>
            <span className="ob-door-head"><Tile icon="study" tone="violet" size="lg" />{!work && <span className="ob-badge tile--violet">Suggested for your email</span>}</span>
            <span className="ob-door-title">For my own research or study</span>
            <p>A personal workspace for students, researchers and independent builders.</p>
            <span className="ob-door-foot">Move your projects into a lab or company organization whenever you're ready.</span>
          </Link>
          <div className="ob-door" aria-disabled="true">
            <span className="ob-door-head"><Tile icon="upload" tone="green" size="lg" /><span className="ob-badge">Opening soon</span></span>
            <span className="ob-door-title">To supply data or labeling work</span>
            <p>License a dataset you have rights to, or take paid collection and annotation tasks.</p>
            <span className="ob-door-foot">Provider accounts aren't open yet. <Link to="/contact">Tell us what you have.</Link></span>
          </div>
          <Link to="/setup/invited" className="ob-door">
            <span className="ob-door-head"><Tile icon="mail" tone="amber" size="lg" /></span>
            <span className="ob-door-title">I was invited</span>
            <p>Join a team, or open a financing application a company shared with your firm.</p>
            <span className="ob-door-foot">You get exactly the access the person who invited you chose.</span>
          </Link>
        </div>
        <p className="ob-muted">Not sure? Most people building a product choose <strong>For my company or team</strong>. Students on a lab project should ask the lab to invite them.</p>
      </main>
    </SetupShell>
  );
}

export function Invited() {
  return (
    <SetupShell status={null} exit={{ to: '/start', label: 'Back' }}>
      <title>Invitations — Valcairn</title>
      <main className="ob-main ob-main--narrow">
        <Tile icon="mail" tone="amber" size="lg" />
        <h1 className="ob-h1">Open the link in your invitation</h1>
        <p className="ob-lede">Invitations are tied to the email they were sent to. Open the link in that email while signed in with the same address, and you'll land in the right workspace with the access you were given.</p>
        <p className="ob-alert ob-alert--info">Accepting invitations by link is still being built. Until then, ask the person who invited you to approve a join request instead.</p>
        <div className="ob-actions"><Link className="btn-ghost" to="/start">Back</Link></div>
      </main>
    </SetupShell>
  );
}

export const orgCreateLoader = requireVerified;

export function OrgCreate() {
  const { user } = useLoaderData();
  const navigate = useNavigate();
  const emailDomain = domainOf(user.email);
  const personalEmail = PERSONAL.includes(emailDomain);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [slugState, setSlugState] = useState(null);
  const [size, setSize] = useState(null);
  const [join, setJoin] = useState(!personalEmail);
  const [forOther, setForOther] = useState(false);
  const [errors, setErrors] = useState({});
  const [message, setMessage] = useState(null);
  const [pending, setPending] = useState(false);
  const shownSlug = slugTouched ? slug : slugify(name);

  async function checkSlug() {
    if (shownSlug.length < 3) return setSlugState(null);
    const res = await api.slugAvailable(shownSlug).catch(() => null);
    setSlugState(res ? (res.available ? 'available' : 'taken') : null);
  }

  async function submit(event) {
    event.preventDefault();
    const form = Object.fromEntries(new FormData(event.currentTarget));
    setPending(true);
    const res = await api.createOrganization({ ...form, slug: shownSlug, sizeBand: size, joinByDomain: join, forSomeoneElse: forOther }).catch(() => null);
    setPending(false);
    if (res?.ok) return navigate(`/w/${res.data.workspace.slug}/setup/team`);
    setErrors(res?.data.errors ?? (res?.data.code === 'slug_taken' ? { slug: res.data.error } : {}));
    setMessage(res?.data.error ?? 'Could not create the organization. Please try again.');
  }

  return (
    <SetupShell tone="blue" context="New organization" exit={{ to: '/start', label: 'Back' }} steps={['Organization', 'Team and roles', 'First project']} current={0}>
      <title>Create your organization — Valcairn</title>
      <form className="ob-main" onSubmit={submit} noValidate>
        <section className="ob-col">
          <div className="ob-intro">
            <h1 className="ob-h1">Create your organization</h1>
            <p className="ob-lede">One shared, private home for your company's projects, data, models and financing.</p>
          </div>
          {message && <p className="ob-alert" role="alert">{message}</p>}
          <div className="ob-grid">
            <div className="ob-field">
              <label htmlFor="org-name">Organization name</label>
              <input id="org-name" name="name" type="text" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} onBlur={checkSlug} aria-invalid={errors.name ? true : undefined} aria-describedby="org-name-error" />
              <FieldError id="org-name-error">{errors.name}</FieldError>
            </div>
            <div className="ob-field">
              <label htmlFor="website">Company website <span className="ob-optional">(optional)</span></label>
              <input id="website" name="website" type="text" maxLength={200} placeholder={personalEmail ? 'example.com' : emailDomain} />
            </div>
          </div>
          <div className="ob-field">
            <label htmlFor="slug">Workspace address</label>
            <div className="ob-prefix"><span>valcairn /</span><input id="slug" type="text" maxLength={48} value={shownSlug} onChange={(e) => { setSlugTouched(true); setSlug(slugify(e.target.value)); setSlugState(null); }} onBlur={checkSlug} aria-invalid={errors.slug || slugState === 'taken' ? true : undefined} aria-describedby="slug-status" /></div>
            <div id="slug-status" aria-live="polite">
              {slugState === 'available' && <span className="ob-ok"><Icon name="check" size={14} stroke={2.6} />Available</span>}
              {slugState === 'taken' && <p className="ob-error">That address is taken. Try another.</p>}
              <FieldError>{errors.slug}</FieldError>
            </div>
          </div>
          <div className="ob-grid">
            <div className="ob-field">
              <label htmlFor="industry">What you build</label>
              <select id="industry" name="industry" defaultValue="">
                <option value="" disabled>Choose one</option>
                <option>Robotics and physical AI</option><option>Manufacturing and industrial</option><option>Healthcare and life sciences</option>
                <option>Finance and insurance</option><option>Software and AI products</option><option>Something else</option>
              </select>
            </div>
            <div className="ob-field">
              <label htmlFor="creator-role">Your role</label>
              <select id="creator-role" name="creatorRole" defaultValue="">
                <option value="" disabled>Choose one</option>
                <option>Founder or executive</option><option>Engineering or ML</option><option>Data or operations</option><option>Finance</option><option>Other</option>
              </select>
            </div>
          </div>
          <fieldset>
            <legend className="ob-legend">Company size</legend>
            <div className="ob-chips">
              {['Just me', '2–10', '11–50', '51–200', '200+'].map((label) => (
                <button key={label} type="button" className="ob-chip" aria-pressed={size === label} onClick={() => setSize(label)}>{label}</button>
              ))}
            </div>
          </fieldset>
          <div className="ob-card" style={{ padding: 0, gap: 0 }}>
            <div className="ob-toggle-row">
              <div className="ob-intro" style={{ gap: 4 }}>
                <strong id="join-label">Let colleagues find this organization</strong>
                <span className="ob-muted">{personalEmail
                  ? 'Needs a company email. You signed up with a personal address, so this stays off. You can still invite people directly.'
                  : `Anyone who confirms an @${emailDomain} email can ask to join. An admin approves each request.`}</span>
              </div>
              <button type="button" role="switch" className="ob-switch" aria-checked={join} aria-labelledby="join-label" disabled={personalEmail} onClick={() => setJoin(!join)} />
            </div>
          </div>
          <label className="ob-check"><input type="checkbox" checked={forOther} onChange={(e) => setForOther(e.target.checked)} />I'm setting this up for someone else</label>
          {forOther && (
            <div className="ob-field ob-card">
              <label htmlFor="owner-email">Who should own it?</label>
              <input id="owner-email" name="ownerEmail" type="email" placeholder="their work email" aria-invalid={errors.ownerEmail ? true : undefined} aria-describedby="owner-error" />
              <FieldError id="owner-error">{errors.ownerEmail}</FieldError>
              <span className="ob-muted">We save an owner invitation for them. You stay on as owner until they accept.</span>
            </div>
          )}
          <div className="ob-actions">
            <Link className="btn-ghost" to="/start">Back</Link>
            <button className="btn-app" type="submit" disabled={pending}>{pending ? 'Creating…' : 'Create organization'} <Icon name="arrow" size={16} /></button>
          </div>
        </section>
        <aside className="ob-aside" aria-label="Preview">
          <div className="ob-preview">
            <div className="ob-preview-band" />
            <div className="ob-preview-body">
              <span className="ob-monogram" aria-hidden="true">{initials(name)}</span>
              <div className="ob-intro" style={{ gap: 2 }}>
                <strong style={{ fontSize: 18 }}>{name.trim() || 'Your organization'}</strong>
                <span className="ob-muted">valcairn/{shownSlug || 'your-company'}</span>
              </div>
              <ul className="ob-areas">
                <li><Tile icon="grid" tone="orange" size="sm" />Projects</li>
                <li><Tile icon="data" tone="teal" size="sm" />Data</li>
                <li><Tile icon="layers" tone="blue" size="sm" />Models</li>
                <li><Tile icon="bank" tone="amber" size="sm" />Financing</li>
              </ul>
              <div className="ob-org-switch"><span className="avatar" style={{ width: 28, height: 28, fontSize: 11 }}>{initials(user.name)}</span><span>{user.name} · <strong>Owner</strong></span></div>
            </div>
          </div>
          {personalEmail && (
            <div className="ob-note tile--violet"><Tile icon="info" tone="violet" size="sm" /><span>You signed up with a personal email. You can still create an organization; colleague matching stays off until it's verified with a company domain.</span></div>
          )}
        </aside>
      </form>
    </SetupShell>
  );
}

export async function matchLoader() {
  const account = await requireVerified();
  if (!account.match) throw redirect('/start');
  return account;
}

export function OrgMatch() {
  const { match, joinRequests } = useLoaderData();
  const [sent, setSent] = useState(joinRequests.some((r) => r.workspaceId === match.id));
  const [message, setMessage] = useState(null);

  async function submit(event) {
    event.preventDefault();
    const res = await api.requestToJoin(match.id, new FormData(event.currentTarget).get('note')).catch(() => null);
    if (res?.ok) setSent(true);
    else setMessage(res?.data.error ?? 'Could not send your request.');
  }

  return (
    <SetupShell tone="blue" context="Your company" status={null} exit={{ to: '/start', label: 'Back' }}>
      <title>Your company is already on Valcairn — Valcairn</title>
      <main className="ob-main ob-main--narrow">
        <div className="ob-intro">
          <span className="ob-badge tile--blue" style={{ alignSelf: 'flex-start' }}>Matched by your email domain</span>
          <h1 className="ob-h1">Your company is already on Valcairn</h1>
          <p className="ob-lede">Joining keeps everyone's data, models and permissions in one place, instead of two workspaces that can't see each other.</p>
        </div>
        <div className="ob-org-row">
          <span className="ob-monogram" style={{ margin: 0, border: 0 }} aria-hidden="true">{initials(match.name)}</span>
          <div className="ob-intro" style={{ gap: 4, flex: '1 1 220px' }}><strong style={{ fontSize: 18 }}>{match.name}</strong><span className="ob-muted">{match.domain} · managed by its admins</span></div>
          <span className="ob-ok"><Icon name="shield" size={14} stroke={2.4} />Verified domain</span>
        </div>
        {message && <p className="ob-alert" role="alert">{message}</p>}
        {sent ? (
          <div className="ob-note tile--green"><Tile icon="clock" tone="green" size="sm" /><span><strong>Request sent.</strong> An admin at {match.name} will review it. Meanwhile you can set up a personal workspace, or come back later.</span></div>
        ) : (
          <form className="ob-intro" style={{ gap: 12 }} onSubmit={submit}>
            <div className="ob-field">
              <label htmlFor="note">Note to the admin <span className="ob-optional">(optional)</span></label>
              <textarea id="note" name="note" rows={2} maxLength={500} placeholder="e.g. I'm on the perception team" />
            </div>
            <button className="btn-app" type="submit" style={{ alignSelf: 'flex-start' }}>Request to join</button>
          </form>
        )}
        <div className="ob-links">
          <Link to="/setup/organization"><span><strong>Create a separate organization</strong><span className="ob-muted">For a different company, or a team that must stay apart. Nothing is shared with {match.name}.</span></span><Icon name="arrow" size={16} /></Link>
          <Link to="/setup/personal"><span><strong>Use a personal workspace for now</strong><span className="ob-muted">Move your projects in once you're approved.</span></span><Icon name="arrow" size={16} /></Link>
          <Link to="/contact"><span><strong>This isn't my company</strong><span className="ob-muted">Tell us if the match looks wrong.</span></span><Icon name="arrow" size={16} /></Link>
        </div>
      </main>
    </SetupShell>
  );
}

export async function teamLoader({ params }) {
  const { entry } = await requireWorkspace(params.slug);
  if (entry.kind !== 'organization') throw redirect(`/w/${entry.slug}`);
  return { entry, detail: await api.workspace(entry.id) };
}

const ROLE_ROWS = [
  ['Admin', 'blue', 'Everything', 'Everything', 'Yes', 'Yes'],
  ['Member', 'orange', 'Their projects', 'Their projects', 'Request only', 'No'],
  ['Finance', 'amber', 'View', 'No', 'Yes', 'Yes'],
  ['Viewer', 'plain', 'View', 'No', 'No', 'No'],
];

export function OrgTeam() {
  const { entry, detail } = useLoaderData();
  const navigate = useNavigate();
  const [rows, setRows] = useState([{ email: '', role: 'member' }, { email: '', role: 'member' }]);
  const [message, setMessage] = useState(null);
  const [saved, setSaved] = useState(null);
  const canAdmin = entry.role === 'owner';
  const next = `/w/${entry.slug}/projects/new`;

  const update = (i, patch) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  async function submit(event) {
    event.preventDefault();
    const invites = rows.filter((r) => r.email.trim());
    if (!invites.length) return navigate(next);
    const res = await api.invite(entry.id, invites).catch(() => null);
    if (res?.ok) setSaved(res.data);
    else setMessage(res?.data.error ?? 'Could not save the invitations.');
  }

  return (
    <SetupShell tone="blue" context={detail.workspace.name} status="Organization created" exit={{ to: `/w/${entry.slug}`, label: 'Exit setup' }} steps={['Organization', 'Team and roles', 'First project']} current={1}>
      <title>Invite your team — Valcairn</title>
      <form className="ob-main" onSubmit={submit} noValidate>
        <section className="ob-col">
          <div className="ob-intro">
            <h1 className="ob-h1">Who else should be here?</h1>
            <p className="ob-lede">Invite the people you'll work with. Roles decide who can see data, approve spend and open financing.</p>
          </div>
          {message && <p className="ob-alert" role="alert">{message}</p>}
          {saved ? (
            <div className="ob-note tile--green"><Tile icon="check" tone="green" size="sm" /><span><strong>{saved.saved} invitation{saved.saved === 1 ? '' : 's'} saved.</strong> {saved.delivered ? 'We emailed them.' : 'Invitation emails aren’t switched on yet, so let them know yourself. They can also request to join with their work email.'}</span></div>
          ) : (
            <div className="ob-intro" style={{ gap: 10 }}>
              {rows.map((row, i) => (
                <div key={i} className="ob-grid" style={{ gridTemplateColumns: 'minmax(0, 2fr) minmax(140px, 1fr)', gap: 10 }}>
                  <div className="ob-field"><label className="visually-hidden" htmlFor={`invite-${i}`}>Email {i + 1}</label><input id={`invite-${i}`} type="email" placeholder={`name@${detail.workspace.domain ?? 'company.com'}`} value={row.email} onChange={(e) => update(i, { email: e.target.value })} /></div>
                  <div className="ob-field"><label className="visually-hidden" htmlFor={`role-${i}`}>Role {i + 1}</label>
                    <select id={`role-${i}`} value={row.role} onChange={(e) => update(i, { role: e.target.value })}>
                      {canAdmin && <option value="admin">Admin</option>}
                      <option value="member">Member</option><option value="finance">Finance</option><option value="viewer">Viewer</option>
                    </select>
                  </div>
                </div>
              ))}
              <button type="button" className="btn-text" style={{ alignSelf: 'flex-start' }} onClick={() => setRows([...rows, { email: '', role: 'member' }])}>+ Add another</button>
            </div>
          )}
          <section className="ob-card" style={{ padding: 0, gap: 0, overflow: 'hidden' }} aria-labelledby="roles-title">
            <h2 id="roles-title" style={{ padding: '14px 18px' }}>What each role can do</h2>
            <div className="ob-table-wrap">
              <table>
                <thead><tr><th scope="col">Role</th><th scope="col">Projects and models</th><th scope="col">Private data</th><th scope="col">Approve spend</th><th scope="col">Financing</th></tr></thead>
                <tbody>
                  {ROLE_ROWS.map(([role, tone, ...cells]) => (
                    <tr key={role}><th scope="row"><span className={`ob-badge tile--${tone}`}>{role}</span></th>{cells.map((c, i) => <td key={i} className={c === 'No' ? 'no' : undefined}>{c}</td>)}</tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <div className="ob-actions">
            <Link className="btn-ghost" to="/start">Back</Link>
            <div>
              {saved ? <Link className="btn-app" to={next}>Continue <Icon name="arrow" size={16} /></Link> : <>
                <Link className="btn-text" to={next}>Skip, I'll invite later</Link>
                <button className="btn-app" type="submit">Send invites <Icon name="arrow" size={16} /></button>
              </>}
            </div>
          </div>
        </section>
        <aside className="ob-aside">
          <div className="ob-card">
            <h2>Other ways in</h2>
            <div className="ob-features" style={{ gap: 14 }}>
              <div style={{ display: 'flex', gap: 12 }}><Tile icon="shield" tone="blue" size="sm" /><span className="ob-muted"><strong style={{ color: 'var(--text)' }}>Colleague matching is {detail.workspace.joinByDomain ? 'on' : 'off'}.</strong> {detail.workspace.joinByDomain ? `People who confirm an @${detail.workspace.domain} email can ask to join. You approve each one.` : 'Turn it on later from a verified company email.'}</span></div>
              <div style={{ display: 'flex', gap: 12 }}><Tile icon="link" tone="plain" size="sm" /><span className="ob-muted"><strong style={{ color: 'var(--text)' }}>Invite links are off.</strong> For contractors outside your domain, coming later.</span></div>
            </div>
          </div>
          <div className="ob-note tile--amber"><span>Financing documents are visible only to Owner, Admin and Finance roles, never to Members, even if they work on the project.</span></div>
        </aside>
      </form>
    </SetupShell>
  );
}
