import Link from "next/link";

export default function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="container footer-main">
        <div className="footer-brand">
          <span className="name">Frontier Intelligence Labs</span>
          <span className="tag">Making frontier intelligence accessible</span>
        </div>
        <div className="footer-cols">
          <div className="footer-col">
            <Link href="/about">About</Link>
            <Link href="/vision">Vision</Link>
            <Link href="/objective">Objective</Link>
          </div>
          <div className="footer-col">
            <Link href="/team">Team</Link>
            <Link href="/contact">Contact</Link>
          </div>
        </div>
      </div>
      <div className="container footer-bottom">
        <span>© 2026 Frontier Intelligence Labs</span>
        <span>
          ψ knowledge&nbsp;&nbsp;·&nbsp;&nbsp;∩ fusion&nbsp;&nbsp;·&nbsp;&nbsp;Δ
          gap&nbsp;&nbsp;·&nbsp;&nbsp;Σ everyone&nbsp;&nbsp;·&nbsp;&nbsp;→ adoption
        </span>
        <span>San Francisco — 37.7749° N, 122.4194° W</span>
      </div>
    </footer>
  );
}
