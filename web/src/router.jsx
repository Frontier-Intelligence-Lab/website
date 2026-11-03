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
]);
