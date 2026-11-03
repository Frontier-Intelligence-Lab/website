import { Link, NavLink, Outlet, isRouteErrorResponse, useLocation, useRouteError } from 'react-router';
import { ThemeToggle } from '../theme.jsx';

export function Shell({ quiet = true, children }) {
  return (
    <div className={`site ${quiet ? 'site--quiet' : 'site--home'}`}>
      <div className="site-art" aria-hidden="true" />
      <header className="site-top">
        <Link className="wordmark" to="/" aria-label="Valcairn home">Valcairn</Link>
        <nav className="site-nav" aria-label="Primary">
          <NavLink to="/contact">Contact</NavLink>
          <Link className="btn btn-outline" to="/demo">Demo login</Link>
          <ThemeToggle />
        </nav>
      </header>
      <main id="main" className="site-main">{children}</main>
      <footer className="site-bottom">
        <span>by Frontier Intelligence Labs</span>
        <a href="https://frontierintelligencelab.com/">frontierintelligencelab.com</a>
      </footer>
    </div>
  );
}

export default function SiteLayout() {
  const { pathname } = useLocation();
  return <Shell quiet={pathname !== '/'}><Outlet /></Shell>;
}

export function Loading() {
  return <div className="loading" role="status">Loading…</div>;
}

export function RouteError() {
  const error = useRouteError();
  const status = isRouteErrorResponse(error) ? error.status : 500;
  const message = status === 429 ? 'Too many requests. Please try again in a few minutes.' : 'Something went wrong. Please try again.';
  return (
    <Shell>
      <title>Error — Valcairn</title>
      <section className="narrow">
        <h1 className="headline">Error.</h1>
        <p className="lede">{message}</p>
        <p><Link to="/">Back to the homepage</Link></p>
      </section>
    </Shell>
  );
}
