import { createBrowserRouter, redirect, useLoaderData } from 'react-router';
import { api } from './api.js';
import SiteLayout, { Loading, RouteError } from './site/SiteLayout.jsx';
import Home from './site/Home.jsx';
import Contact from './site/Contact.jsx';
import DemoLogin from './site/DemoLogin.jsx';
import NotFound from './site/NotFound.jsx';

// The dashboard chunk is built under /private/ and only loads after the session check passes.
async function reviewLoader() {
  const { reviewer } = await api.session();
  if (!reviewer) throw redirect('/demo');
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
          if (reviewer) throw redirect('/demo/review');
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
  return [
    { path: '/signup', lazy: page(auth, 'SignUp', 'signUpLoader') },
    { path: '/signin', lazy: page(auth, 'SignIn', 'signInLoader') },
    { path: '/verify', lazy: page(auth, 'Verify', 'verifyLoader') },
    { path: '/start', lazy: page(org, 'Start', 'startLoader') },
    { path: '/setup/invited', lazy: page(org, 'Invited') },
    { path: '/setup/organization', lazy: page(org, 'OrgCreate', 'orgCreateLoader') },
    { path: '/setup/match', lazy: page(org, 'OrgMatch', 'matchLoader') },
    { path: '/setup/personal', lazy: page(personal, 'Personal', 'personalLoader') },
    { path: '/w/:slug', lazy: page(project, 'ProjectHome', 'workspaceHomeLoader') },
    { path: '/w/:slug/setup/team', lazy: page(org, 'OrgTeam', 'teamLoader') },
    { path: '/w/:slug/projects/new', lazy: page(project, 'ProjectGoal', 'goalLoader') },
    { path: '/w/:slug/projects/:projectId', lazy: page(project, 'ProjectHome', 'projectHomeLoader') },
    { path: '/w/:slug/projects/:projectId/success', lazy: page(project, 'ProjectSuccess', 'successLoader') },
    { path: '/w/:slug/projects/:projectId/data', lazy: page(project, 'ProjectData', 'dataLoader') },
  ].map((route) => ({ ...route, ErrorBoundary: RouteError, HydrateFallback: Loading }));
}
