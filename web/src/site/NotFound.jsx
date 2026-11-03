import { Link } from 'react-router';

export default function NotFound() {
  return (
    <section className="narrow">
      <title>Not found — Valcairn</title>
      <h1 className="headline">Not found.</h1>
      <p className="lede">That page does not exist.</p>
      <p><Link to="/">Back to the homepage</Link></p>
    </section>
  );
}
