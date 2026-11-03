import { createHmac, randomBytes, randomInt } from 'node:crypto';
import nodemailer from 'nodemailer';
import { hashPassword, verifyPassword } from './lib/passwords.js';
import { StoreError } from './store/index.js';
import { PERSONAL_DOMAINS, emailDomain, isEmail, normalizeDomain, slugify, validateProjectPatch, validateProjectStart } from './lib/onboarding.js';

const ROLES = ['owner', 'admin', 'member', 'finance', 'viewer'];
const CAN = {
  manageMembers: ['owner', 'admin'],
  writeProjects: ['owner', 'admin', 'member'],
  readProjects: ROLES,
};
const CODE_TTL_MS = 15 * 60 * 1000;
const INVITE_TTL_MS = 7 * 86400 * 1000;
const STATUS = { email_taken: 409, slug_taken: 409, personal_exists: 409, already_member: 409, already_decided: 409, not_found: 404 };
const MESSAGES = {
  email_taken: 'An account with that email already exists. Sign in instead.',
  slug_taken: 'That workspace address is taken. Try another.',
  personal_exists: 'You already have a personal workspace.',
  already_member: 'You are already a member of this organization.',
  already_decided: 'This request was already decided.',
  not_found: 'Not found.',
};

const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const pick = (value, allowed, fallback = null) => (allowed.includes(value) ? value : fallback);

/** Verification and invite emails. Without SMTP nothing is sent; outside production the code is returned for local testing. */
function createMailer(smtp, transport = smtp ? nodemailer.createTransport({ host: smtp.host, port: smtp.port, secure: smtp.secure, auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined }) : null) {
  if (!smtp || !transport) return { configured: false, async send() { throw new Error('Email delivery is not configured'); } };
  return {
    configured: true,
    send: ({ to, subject, body }) => transport.sendMail({ from: smtp.from, to, subject, text: body }),
  };
}

export async function registerAccountRoutes(app, { config, store, mailTransport, rateLimits = {}, helpers }) {
  const { sameOrigin, privateHeaders, problem } = helpers;
  const mailer = createMailer(config.smtp, mailTransport);
  const pepper = (value) => createHmac('sha256', config.sessionSecret).update(String(value)).digest('hex');
  const exposeCodes = !config.isProd && !mailer.configured;
  const dummyHash = await hashPassword('dummy-password-for-constant-time', { cost: 2 ** 12 });

  const fail = (reply, err) => {
    if (err instanceof StoreError) return problem(reply, STATUS[err.code] ?? 400, MESSAGES[err.code] ?? 'The request could not be completed.', { code: err.code });
    throw err;
  };

  // Every account route: private headers, and 503 when this server has no store.
  const base = async (request, reply) => {
    privateHeaders(reply);
    if (!store) return problem(reply, 503, 'Accounts are not available on this server yet.');
  };
  const signedIn = async (request, reply) => {
    const userId = request.session.get('account')?.userId;
    const user = userId ? await store.getUserById(userId) : null;
    if (!user) return problem(reply, 401, 'Sign in first.');
    request.user = user;
  };
  const verified = async (request, reply) => {
    if (!request.user.emailVerifiedAt) return problem(reply, 403, 'Confirm your email first.', { code: 'email_unverified' });
  };
  const member = (ability) => async (request, reply) => {
    const membership = await store.getMembership(request.params.workspaceId, request.user.id);
    // Not a member: answer as if the workspace did not exist.
    if (!membership) return problem(reply, 404, 'Not found.');
    if (!CAN[ability].includes(membership.role)) return problem(reply, 403, 'Your role does not allow this.');
    request.role = membership.role;
  };
  const post = (extra = []) => ({ preHandler: [base, sameOrigin, ...extra] });
  const get = (extra = []) => ({ preHandler: [base, ...extra] });

  async function sendCode(user, purpose = 'signup', email = user.email) {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await store.createEmailCode({ userId: user.id, email, purpose, codeHash: pepper(code), expiresAt: new Date(Date.now() + CODE_TTL_MS) });
    if (mailer.configured) {
      await mailer.send({ to: email, subject: `Your Valcairn code: ${code}`, body: `Your Valcairn confirmation code is ${code}. It expires in 15 minutes.\n\nIf you didn't ask for it, ignore this email.` });
      return {};
    }
    if (exposeCodes) {
      app.log.info({ email, purpose, code }, 'development email code (no SMTP configured)');
      return { devCode: code };
    }
    return null;
  }

  async function accountView(user) {
    const memberships = await store.listWorkspacesForUser(user.id);
    const requests = await store.listJoinRequestsForUser(user.id);
    return {
      user,
      workspaces: memberships.map(({ workspace: w, role }) => ({ id: w.id, kind: w.kind, name: w.name, slug: w.slug, role })),
      joinRequests: requests.filter((r) => r.status === 'pending').map((r) => ({ id: r.id, workspaceId: r.workspaceId, workspaceName: r.workspaceName, status: r.status })),
    };
  }

  async function domainMatch(user) {
    const domain = emailDomain(user.email);
    if (!user.emailVerifiedAt || !domain || PERSONAL_DOMAINS.has(domain)) return null;
    const match = await store.findWorkspaceByJoinDomain(domain);
    if (!match || (await store.getMembership(match.id, user.id))) return null;
    return match;
  }

  const limit = (max) => ({ rateLimit: { max, timeWindow: '15 minutes' } });

  app.get('/api/account', get(), async (request) => {
    const userId = request.session.get('account')?.userId;
    const user = userId ? await store.getUserById(userId) : null;
    if (!user) return { user: null, signupOpen: config.accountSignup };
    return { ...(await accountView(user)), match: await domainMatch(user), signupOpen: config.accountSignup };
  });

  app.post('/api/account/signup', { ...post(), config: limit(rateLimits.signup ?? 10) }, async (request, reply) => {
    if (!config.accountSignup) return problem(reply, 503, 'New accounts are not open yet.');
    const name = text(request.body?.name, 120);
    const email = text(request.body?.email, 254).toLowerCase();
    const password = typeof request.body?.password === 'string' ? request.body.password.slice(0, 256) : '';
    const errors = {};
    if (!name) errors.name = 'Please tell us your name.';
    if (!isEmail(email)) errors.email = 'That email address does not look valid.';
    if (password.length < 10) errors.password = 'Use at least 10 characters.';
    if (Object.keys(errors).length) return problem(reply, 400, 'Please check the highlighted fields.', { errors });
    if (!mailer.configured && !exposeCodes) return problem(reply, 503, 'Email confirmation is not configured, so sign-up is unavailable.');
    let user;
    try {
      user = await store.createUser({ email, name, passwordHash: await hashPassword(password) });
    } catch (err) { return fail(reply, err); }
    await request.session.regenerate();
    request.session.set('account', { userId: user.id });
    const sent = await sendCode(user);
    await store.recordAudit({ actorId: user.id, action: 'user.signed_up', targetType: 'user', targetId: user.id });
    return { user, ...sent };
  });

  app.post('/api/account/signin', { ...post(), config: limit(rateLimits.signin ?? 10) }, async (request, reply) => {
    const email = text(request.body?.email, 254).toLowerCase();
    const password = typeof request.body?.password === 'string' ? request.body.password.slice(0, 256) : '';
    const auth = await store.getUserAuthByEmail(email);
    const ok = await verifyPassword(password, auth?.passwordHash ?? dummyHash);
    if (!ok || !auth) return problem(reply, 401, 'That email and password did not match an account.');
    await request.session.regenerate();
    request.session.set('account', { userId: auth.user.id });
    return accountView(auth.user);
  });

  app.post('/api/account/signout', post(), async (request) => {
    request.session.set('account', undefined);
    await request.session.destroy();
    return { ok: true };
  });

  app.post('/api/account/verify', { ...post([signedIn]), config: limit(rateLimits.verify ?? 20) }, async (request, reply) => {
    const code = text(request.body?.code, 12).replace(/\s/g, '');
    if (!/^\d{6}$/.test(code)) return problem(reply, 400, 'Enter the 6-digit code from your email.');
    const result = await store.consumeEmailCode({ userId: request.user.id, purpose: 'signup', codeHash: pepper(code) });
    if (!result.ok) {
      const message = result.reason === 'expired' ? 'That code has expired. Send a new one.'
        : result.reason === 'too_many_attempts' ? 'Too many wrong codes. Send a new one.' : 'That code is not right.';
      return problem(reply, 400, message, { reason: result.reason });
    }
    const user = await store.setEmailVerified(request.user.id);
    return { user, match: await domainMatch(user) };
  });

  app.post('/api/account/verify/resend', { ...post([signedIn]), config: limit(rateLimits.resend ?? 5) }, async (request, reply) => {
    if (request.user.emailVerifiedAt) return { ok: true, alreadyVerified: true };
    const sent = await sendCode(request.user);
    if (!sent) return problem(reply, 503, 'Email delivery is not configured.');
    return { ok: true, ...sent };
  });

  app.get('/api/workspaces/slug-available', get([signedIn]), async (request) => {
    const slug = slugify(text(request.query?.slug, 60));
    return { slug, available: slug.length >= 3 && (await store.isSlugAvailable(slug)) };
  });

  app.post('/api/workspaces', post([signedIn, verified]), async (request, reply) => {
    const body = request.body ?? {};
    const name = text(body.name, 120);
    const slug = slugify(text(body.slug, 60) || name);
    const website = text(body.website, 200);
    const domain = normalizeDomain(website) || emailDomain(request.user.email);
    const errors = {};
    if (!name) errors.name = 'Name your organization.';
    if (slug.length < 3) errors.slug = 'Use at least 3 letters or numbers.';
    const ownerEmail = text(body.ownerEmail, 254).toLowerCase();
    if (body.forSomeoneElse && !isEmail(ownerEmail)) errors.ownerEmail = 'Enter the owner’s work email.';
    if (Object.keys(errors).length) return problem(reply, 400, 'Please check the highlighted fields.', { errors });

    // Domain counts as verified when the creator confirmed an email at that same company domain.
    const domainVerified = Boolean(domain && !PERSONAL_DOMAINS.has(domain) && emailDomain(request.user.email) === domain);
    try {
      const workspace = await store.createWorkspace({
        kind: 'organization', name, slug, website: website || null, domain: PERSONAL_DOMAINS.has(domain) ? null : domain,
        domainVerified, joinByDomain: Boolean(body.joinByDomain) && domainVerified,
        industry: text(body.industry, 80) || null, sizeBand: text(body.sizeBand, 20) || null,
        profile: { creatorRole: text(body.creatorRole, 80) || null }, ownerId: request.user.id,
      });
      if (body.forSomeoneElse) {
        await store.createInvitations({ workspaceId: workspace.id, invitedBy: request.user.id, invites: [{ email: ownerEmail, role: 'owner', tokenHash: pepper(randomBytes(24).toString('base64url')), expiresAt: new Date(Date.now() + INVITE_TTL_MS) }] });
      }
      return { workspace, domainVerified };
    } catch (err) { return fail(reply, err); }
  });

  app.post('/api/workspaces/personal', post([signedIn, verified]), async (request, reply) => {
    const body = request.body ?? {};
    const profile = {
      kind: pick(body.kind, ['student', 'researcher', 'independent'], 'independent'),
      institution: text(body.institution, 160) || null,
      lab: text(body.lab, 160) || null,
      work: text(body.work, 1000) || null,
    };
    const base = slugify(request.user.name) || 'workspace';
    try {
      let slug = `${base}-personal`;
      for (let i = 2; !(await store.isSlugAvailable(slug)) && i < 50; i++) slug = `${base}-personal-${i}`;
      const workspace = await store.createWorkspace({ kind: 'personal', name: request.user.name, slug, profile, ownerId: request.user.id });
      return { workspace };
    } catch (err) { return fail(reply, err); }
  });

  app.post('/api/workspaces/:workspaceId/join-requests', post([signedIn, verified]), async (request, reply) => {
    const match = await domainMatch(request.user);
    if (!match || match.id !== request.params.workspaceId) return problem(reply, 404, 'Not found.');
    try {
      const joinRequest = await store.createJoinRequest({ workspaceId: match.id, userId: request.user.id, note: text(request.body?.note, 500) });
      return { joinRequest: { id: joinRequest.id, status: joinRequest.status, workspaceName: match.name } };
    } catch (err) { return fail(reply, err); }
  });

  app.get('/api/workspaces/:workspaceId', get([signedIn, member('readProjects')]), async (request) => {
    const workspace = await store.getWorkspace(request.params.workspaceId);
    const manage = CAN.manageMembers.includes(request.role);
    const pending = manage ? await store.listJoinRequests(workspace.id) : [];
    // Admins see who is asking; the requester's id stays server-side.
    const joinRequests = await Promise.all(pending.map(async (r) => {
      const requester = await store.getUserById(r.userId);
      return { id: r.id, note: r.note, createdAt: r.createdAt, name: requester?.name ?? 'Unknown', email: requester?.email ?? null };
    }));
    return {
      workspace,
      role: request.role,
      members: await store.listMembers(workspace.id),
      invitations: manage ? await store.listInvitations(workspace.id) : [],
      joinRequests,
    };
  });

  app.post('/api/workspaces/:workspaceId/invitations', post([signedIn, member('manageMembers')]), async (request, reply) => {
    const list = Array.isArray(request.body?.invites) ? request.body.invites.slice(0, 20) : [];
    const invites = [];
    for (const raw of list) {
      const email = text(raw?.email, 254).toLowerCase();
      if (!email) continue;
      if (!isEmail(email)) return problem(reply, 400, `${email} does not look like an email address.`);
      const role = pick(raw?.role, ['admin', 'member', 'finance', 'viewer']);
      if (!role) return problem(reply, 400, 'Pick a role for each person.');
      if (role === 'admin' && request.role !== 'owner') return problem(reply, 403, 'Only owners can invite admins.');
      invites.push({ email, role, tokenHash: pepper(randomBytes(24).toString('base64url')), expiresAt: new Date(Date.now() + INVITE_TTL_MS) });
    }
    if (!invites.length) return problem(reply, 400, 'Add at least one email address.');
    try {
      const count = await store.createInvitations({ workspaceId: request.params.workspaceId, invitedBy: request.user.id, invites });
      // Invite emails need SMTP and the accept flow; until then invites are saved but not delivered.
      return { saved: count, delivered: false };
    } catch (err) { return fail(reply, err); }
  });

  app.post('/api/workspaces/:workspaceId/join-requests/:requestId/decision', post([signedIn, member('manageMembers')]), async (request, reply) => {
    try {
      const decided = await store.decideJoinRequest({ workspaceId: request.params.workspaceId, requestId: request.params.requestId, deciderId: request.user.id, approve: request.body?.approve === true });
      return { joinRequest: decided };
    } catch (err) { return fail(reply, err); }
  });

  app.get('/api/workspaces/:workspaceId/projects', get([signedIn, member('readProjects')]), async (request) => ({
    projects: await store.listProjects(request.params.workspaceId),
  }));

  app.post('/api/workspaces/:workspaceId/projects', post([signedIn, member('writeProjects')]), async (request, reply) => {
    const { values, errors } = validateProjectStart(request.body);
    if (errors) return problem(reply, 400, 'Please check the highlighted fields.', { errors });
    const project = await store.createProject({ workspaceId: request.params.workspaceId, createdBy: request.user.id, ...values });
    return { project };
  });

  app.get('/api/workspaces/:workspaceId/projects/:projectId', get([signedIn, member('readProjects')]), async (request, reply) => {
    const project = await store.getProject({ workspaceId: request.params.workspaceId, projectId: request.params.projectId });
    return project ? { project, role: request.role } : problem(reply, 404, 'Not found.');
  });

  app.post('/api/workspaces/:workspaceId/projects/:projectId', post([signedIn, member('writeProjects')]), async (request, reply) => {
    const current = await store.getProject({ workspaceId: request.params.workspaceId, projectId: request.params.projectId });
    if (!current) return problem(reply, 404, 'Not found.');
    const { patch, errors } = validateProjectPatch(request.body, current);
    if (errors) return problem(reply, 400, errors.form ?? 'Please check the highlighted fields.', { errors });
    const project = await store.updateProject({ workspaceId: request.params.workspaceId, projectId: request.params.projectId, patch });
    if (!project) return problem(reply, 404, 'Not found.');
    await store.recordAudit({ workspaceId: project.workspaceId, actorId: request.user.id, action: 'project.updated', targetType: 'project', targetId: project.id, metadata: { fields: Object.keys(patch) } });
    return { project };
  });

  return { mailer };
}
