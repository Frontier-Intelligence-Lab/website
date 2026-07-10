import Link from "next/link";
import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";
import TunnelingFigure from "@/components/TunnelingFigure";

const PRACTICES = [
  {
    num: "01",
    title: "Translate",
    desc: "Research, practices, and emerging technologies from frontier labs — distilled into clear, usable knowledge.",
  },
  {
    num: "02",
    title: "Enable",
    desc: "Practical guidance and best practices that help people and organizations adopt what works.",
  },
  {
    num: "03",
    title: "Connect",
    desc: "An open bridge between the San Francisco AI ecosystem and the wider world it is building for.",
  },
];

const EQUATIONS = [
  {
    num: "01",
    topic: "Transformers",
    formula: (
      <>
        Attention(Q, K, V) = softmax( QK<sup>⊤</sup> ∕ √d<sub>k</sub> ) V
      </>
    ),
    note: "How a model decides what matters.",
  },
  {
    num: "02",
    topic: "Language models",
    formula: (
      <>
        p(x<sub>1:T</sub>) = ∏<sub>t</sub> p( x<sub>t</sub> | x<sub>&lt;t</sub> )
      </>
    ),
    note: "Language, one token at a time.",
  },
  {
    num: "03",
    topic: "Training",
    formula: (
      <>
        L(θ) = − Σ<sub>t</sub> log p<sub>θ</sub>( x<sub>t</sub> | x<sub>&lt;t</sub> )
      </>
    ),
    note: "The whole curriculum: predict what comes next.",
  },
  {
    num: "04",
    topic: "Quantum",
    formula: <>iħ ∂ψ ∕ ∂t = Ĥψ</>,
    note: "How possibility evolves in time.",
  },
  {
    num: "05",
    topic: "Tunneling",
    formula: (
      <>
        T ≈ e<sup>−2κd</sup>, &nbsp;κ = √( 2m(V−E) ) ∕ ħ
      </>
    ),
    note: "Even high barriers transmit.",
  },
  {
    num: "06",
    topic: "Diffusion",
    formula: (
      <>
        x<sub>t</sub> = √<span className="bar">α</span>
        <sub>t</sub> x<sub>0</sub> + √( 1 − <span className="bar">α</span>
        <sub>t</sub> ) ε
      </>
    ),
    note: "Structure recovered from noise.",
  },
];

export default function Home() {
  return (
    <>
      <SiteHeader />

      <section className="container hero">
        <span aria-hidden="true" className="hero-watermark">
          ψ
        </span>
        <div className="hero-kicker">
          <span>
            <span className="num">§ 01</span>
            <span className="muted">&nbsp;&nbsp;—&nbsp;&nbsp;An independent intelligence lab</span>
          </span>
          <span className="muted">San Francisco&nbsp;&nbsp;·&nbsp;&nbsp;ψ(x, t)</span>
        </div>
        <h1 className="hero-title">
          Making frontier
          <br />
          intelligence <em>accessible</em>.
        </h1>
        <div className="hero-aside">
          <div className="hero-aside-inner">
            <div className="hero-rule" />
            <p className="hero-lede">
              We translate complex ideas, emerging technologies, and practices from the frontier AI
              ecosystem into accessible knowledge for widespread adoption.
            </p>
            <div className="hero-ctas">
              <Link href="/about" className="cta-link">
                About the lab&nbsp;&nbsp;→
              </Link>
              <Link href="/contact" className="cta-link">
                Get in touch&nbsp;&nbsp;→
              </Link>
            </div>
            <div className="axiom">
              <div className="axiom-label">Axiom 01 — Alignment</div>
              <div className="axiom-eq">
                π<sup>⋆</sup> = argmax<sub>π</sub> E[ r(x, y) ] − β·D<sub>KL</sub>( π ∥ π
                <sub>ref</sub> )
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="figure-section">
        <div className="container">
          <div className="figure-stage">
            <TunnelingFigure />
            <span className="figure-corner tl">+</span>
            <span className="figure-corner tr">+</span>
            <span className="figure-corner bl">+</span>
            <span className="figure-corner br">+</span>
            <div className="figure-callout callout-incident">
              ψ — incident · frontier knowledge
              <span className="tick" />
            </div>
            <div className="figure-callout callout-barrier">
              The barrier — complexity · cost · access
              <span className="tick" />
            </div>
            <div className="figure-callout callout-transmitted">
              Transmitted — adoption
              <span className="tick" />
            </div>
          </div>
          <div className="figure-caption">
            <span>Fig. 01 — Tunneling through the barrier</span>
            <span>
              T ≈ e<sup>−2κd</sup> · schematic, not to scale
            </span>
          </div>
        </div>
      </section>

      <section className="container what-we-do">
        <div className="section-grid">
          <div className="section-marker">
            <div className="num">§ 02</div>
            <div className="glyph">∴</div>
            <div className="name">Practice</div>
          </div>
          <div>
            {PRACTICES.map(({ num, title, desc }) => (
              <div key={num} className="practice-row">
                <div className="practice-num">{num}</div>
                <div className="practice-title">{title}</div>
                <div className="practice-desc">{desc}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="container equations">
        <div className="section-grid">
          <div className="section-marker">
            <div className="num">§ 03</div>
            <div className="glyph">∮</div>
            <div className="name">Reference</div>
          </div>
          <div>
            <p className="equations-intro">
              The <em>mathematics</em> the frontier runs on.
            </p>
            <div className="equations-grid">
              {EQUATIONS.map(({ num, topic, formula, note }) => (
                <div key={num} className="equation-card">
                  <div className="equation-label">
                    <span className="num">{num}</span>&nbsp;&nbsp;·&nbsp;&nbsp;{topic}
                  </div>
                  <div className="equation-formula">{formula}</div>
                  <div className="equation-note">{note}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="band">
        <div className="container band-inner">
          <div className="band-kicker">
            <span className="num">§ 04</span>
            <span className="rest">&nbsp;&nbsp;—&nbsp;&nbsp;Position&nbsp;&nbsp;·&nbsp;&nbsp;≡</span>
          </div>
          <p className="band-statement">
            The frontier moves fast. <em>Understanding should keep pace.</em>
          </p>
          <div className="band-cta-row">
            <Link href="/contact" className="band-cta">
              Work with us&nbsp;&nbsp;→
            </Link>
          </div>
        </div>
      </section>

      <SiteFooter />
    </>
  );
}
