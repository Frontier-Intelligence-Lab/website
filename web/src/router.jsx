import { createBrowserRouter, redirect, useLoaderData } from 'react-router';
import { api } from './api.js';
import { forgetIfSignedOut } from './app/memory.js';
import { resolveReviewerEntry } from './reviewer-entry.js';
import SiteLayout, { Loading, RouteError } from './site/SiteLayout.jsx';
import Home from './site/Home.jsx';
import Contact from './site/Contact.jsx';
import DemoLogin from './site/DemoLogin.jsx';
import NotFound from './site/NotFound.jsx';

async function enterReviewerProduct(reviewer) {
  const entry = await resolveReviewerEntry({ reviewer, fetchAccount: api.account, enterWorkspace: api.demoEnter });
  if (entry.kind === 'workspace') throw redirect(entry.to);
  if (entry.kind === 'signed_out') {
    // The reviewer session ended before the Dashboard could mount (disabled account, expiry): this tab's local-memory
    // keys go with it, unless an ordinary account still holds them or that cannot be confirmed.
    await forgetIfSignedOut({ reviewer: null, fetchAccount: api.account });
    throw redirect('/demo');
  }
  if (entry.kind === 'unavailable') throw new Response(entry.message, { status: entry.status });
}

// Only the admin audit overview remains a separate private chunk. Mapped
// external reviewers use the exact same /w/:slug product as normal accounts.
async function reviewLoader() {
  const { reviewer } = await api.session();
  await enterReviewerProduct(reviewer);
  const { default: Dashboard } = await import('./private/Dashboard.jsx');
  return { reviewer, Dashboard };
}

function Review() {
  const { reviewer, Dashboard } = useLoaderData();
  return <Dashboard reviewer={reviewer} />;
}

export const router = createBrowserRouter([
  {
    path: '/',
    Component: SiteLayout,
    ErrorBoundary: RouteError,
    HydrateFallback: Loading,
    children: [
      { index: true, Component: Home },
      { path: 'contact', loader: api.config, Component: Contact },
      {
        path: 'demo',
        loader: async () => {
          const [config, { reviewer }] = await Promise.all([api.config(), api.session()]);
          if (reviewer) {
            await enterReviewerProduct(reviewer);
            throw redirect('/demo/review');
          }
          // Same confirmed-loss rule as the overview loader: a stale reviewer connection is not left behind here.
          await forgetIfSignedOut({ reviewer, fetchAccount: api.account });
          return config;
        },
        Component: DemoLogin,
      },
      { path: '*', Component: NotFound },
    ],
  },
  { path: '/demo/review', loader: reviewLoader, Component: Review, ErrorBoundary: RouteError, HydrateFallback: Loading },
  ...accountRoutes(),
]);

// Accounts and onboarding load as their own chunks; the API enforces sign-in and membership.
function accountRoutes() {
  const page = (load, name, loaderName) => async () => {
    const mod = await load();
    return { Component: mod[name], loader: loaderName ? mod[loaderName] : undefined };
  };
  const auth = () => import('./app/auth.jsx');
  const org = () => import('./app/org.jsx');
  const personal = () => import('./app/personal.jsx');
  const project = () => import('./app/project.jsx');
  const dataset = () => import('./app/dataset.jsx');
  const invite = () => import('./app/invite.jsx');
  const staff = () => import('./app/staff.jsx');
  const models = () => import('./app/models.jsx');
  const device = () => import('./app/device.jsx');
  const memory = () => import('./app/memory.jsx');
  const capital = () => import('./app/capital.jsx');
  const agents = () => import('./app/agents.jsx');
  const compute = () => import('./app/compute.jsx');
  const evaluate = () => import('./app/evaluate.jsx');
  const research = () => import('./app/research.jsx');
  return [
    { path: '/signup', lazy: page(auth, 'SignUp', 'signUpLoader') },
    { path: '/signin', lazy: page(auth, 'SignIn', 'signInLoader') },
    { path: '/verify', lazy: page(auth, 'Verify', 'verifyLoader') },
    { path: '/start', lazy: page(org, 'Start', 'startLoader') },
    { path: '/setup/invited', lazy: page(org, 'Invited') },
    { path: '/setup/organization', lazy: page(org, 'OrgCreate', 'orgCreateLoader') },
    { path: '/setup/match', lazy: page(org, 'OrgMatch', 'matchLoader') },
    { path: '/setup/personal', lazy: page(personal, 'Personal', 'personalLoader') },
    { path: '/w/:slug', lazy: page(project, 'WorkspaceHome', 'workspaceHomeLoader') },
    { path: '/w/:slug/research', lazy: page(research, 'ResearchHome', 'researchHomeLoader') },
    { path: '/w/:slug/research/:projectId', lazy: page(research, 'ResearchProject', 'researchProjectLoader') },
    { path: '/w/:slug/research/:projectId/entities/:entityId', lazy: page(research, 'ResearchEntity', 'researchEntityLoader') },
    { path: '/w/:slug/research/:projectId/runs/:runId', lazy: page(research, 'ResearchRun', 'researchRunLoader') },
    { path: '/w/:slug/setup/team', lazy: page(org, 'OrgTeam', 'teamLoader') },
    { path: '/w/:slug/projects/new', lazy: page(project, 'ProjectGoal', 'goalLoader') },
    { path: '/w/:slug/projects/:projectId', lazy: page(project, 'ProjectHome', 'projectHomeLoader') },
    { path: '/w/:slug/projects/:projectId/evaluate', lazy: page(evaluate, 'EvalHome', 'evalHomeLoader'), HydrateFallback: Loading, ErrorBoundary: RouteError },
    { path: '/w/:slug/projects/:projectId/evaluate/:setId', lazy: page(evaluate, 'EvalSet', 'evalSetLoader'), HydrateFallback: Loading, ErrorBoundary: RouteError },
    { path: '/w/:slug/projects/:projectId/evaluate/:setId/review/:comparisonId', lazy: page(evaluate, 'EvalReview', 'evalReviewLoader'), HydrateFallback: Loading, ErrorBoundary: RouteError },
    { path: '/w/:slug/projects/:projectId/evaluate/:setId/reports/:reportId', lazy: page(evaluate, 'EvalReport', 'evalReportLoader'), HydrateFallback: Loading, ErrorBoundary: RouteError },
    { path: '/w/:slug/projects/:projectId/success', lazy: page(project, 'ProjectSuccess', 'successLoader') },
    { path: '/w/:slug/projects/:projectId/data', lazy: page(project, 'ProjectData', 'dataLoader') },
    { path: '/w/:slug/projects/:projectId/model', lazy: page(project, 'ProjectModel', 'modelLoader') },
    { path: '/w/:slug/projects/:projectId/dataset', lazy: page(dataset, 'DatasetOverview', 'datasetLoader') },
    { path: '/w/:slug/projects/:projectId/dataset/annotate', lazy: page(dataset, 'DatasetAnnotate', 'datasetLoader') },
    { path: '/w/:slug/projects/:projectId/dataset/annotate/:uploadId', lazy: page(dataset, 'DatasetAnnotate', 'datasetLoader') },
    { path: '/w/:slug/projects/:projectId/dataset/resolve', lazy: page(dataset, 'DatasetResolve', 'datasetLoader') },
    { path: '/w/:slug/projects/:projectId/dataset/import', lazy: page(dataset, 'DatasetImport', 'datasetLoader') },
    { path: '/w/:slug/projects/:projectId/dataset/versions', lazy: page(dataset, 'DatasetVersions', 'datasetLoader') },
    { path: '/w/:slug/device', lazy: page(device, 'RunOnDevice', 'deviceLoader') },
    { path: '/w/:slug/memory', lazy: page(memory, 'MemoryPage', 'memoryLoader') },
    { path: '/w/:slug/agents', lazy: page(agents, 'AgentsPage', 'agentsLoader') },
    { path: '/w/:slug/compute', lazy: page(compute, 'Compute', 'computeLoader') },
    { path: '/w/:slug/models', lazy: page(models, 'ModelCatalog', 'modelsLoader') },
    { path: '/w/:slug/models/mine', lazy: page(models, 'MyModels', 'modelsLoader') },
    { path: '/w/:slug/models/catalog/:modelId', lazy: page(models, 'ModelDetail', 'modelsLoader') },
    { path: '/w/:slug/models/runs', lazy: page(models, 'EnhanceRuns', 'modelsLoader') },
    { path: '/w/:slug/models/runs/new', lazy: page(models, 'EnhanceRun', 'enhanceLoader') },
    { path: '/w/:slug/models/runs/:runId', lazy: page(models, 'EnhanceRun', 'enhanceLoader') },
    { path: '/w/:slug/capital', lazy: page(capital, 'CapitalHome', 'capitalLoader') },
    { path: '/w/:slug/capital/cases/:caseId', lazy: page(capital, 'CapitalPlan', 'caseLoader') },
    { path: '/w/:slug/capital/cases/:caseId/request', lazy: page(capital, 'CapitalRequest', 'caseLoader') },
    { path: '/w/:slug/capital/cases/:caseId/evidence', lazy: page(capital, 'CapitalEvidence', 'caseLoader') },
    { path: '/invite/:token', lazy: page(invite, 'Invite', 'inviteLoader') },
    { path: '/staff', lazy: page(staff, 'StaffQueue', 'queueLoader') },
    { path: '/staff/reviews/:reviewId', lazy: page(staff, 'StaffReview', 'reviewLoader') },
    { path: '/staff/capital', lazy: page(capital, 'StaffCapitalQueue', 'staffCapitalLoader') },
    { path: '/staff/capital/:caseId', lazy: page(capital, 'StaffCapitalCase', 'staffCapitalCaseLoader') },
  ].map((route) => ({ ...route, ErrorBoundary: RouteError, HydrateFallback: Loading }));
}
