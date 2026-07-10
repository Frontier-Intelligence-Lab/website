import Link from "next/link";

const NAV = [
  { href: "/about", label: "About" },
  { href: "/vision", label: "Vision" },
  { href: "/objective", label: "Objective" },
  { href: "/team", label: "Team" },
  { href: "/contact", label: "Contact" },
];

export default function SiteHeader() {
  return (
    <>
      <div className="accent-bar" />
      <header className="site-header">
        <div className="container site-header-inner">
          <Link href="/" className="brand">
            <span className="brand-mark" aria-hidden="true">
              <span className="ring ring-l" />
              <span className="ring ring-r" />
              <span className="dot" />
            </span>
            <span className="brand-name">Frontier Intelligence Labs</span>
          </Link>
          <nav className="site-nav">
            {NAV.map(({ href, label }) => (
              <Link key={href} href={href}>
                {label}
              </Link>
            ))}
          </nav>
        </div>
      </header>
      <div className="meta-strip">
        <div className="container meta-strip-inner">
          <span>Est. 2026 ∕ San Francisco</span>
          <span>ψ → ∩ → Σ&nbsp;&nbsp;·&nbsp;&nbsp;from the frontier, for everyone</span>
          <span>[ 01 ∕ 06 ]</span>
        </div>
      </div>
    </>
  );
}
