// Labelled input with an inline error wired to aria-describedby.
export default function Field({ name, label, error, optional, textarea, ...input }) {
  const errorId = `${name}-error`;
  const props = {
    id: name,
    name,
    required: !optional,
    'aria-invalid': error ? true : undefined,
    'aria-describedby': error ? errorId : undefined,
    ...input,
  };
  return (
    <div className="field">
      <label htmlFor={name}>{label}{optional && <span className="muted"> (optional)</span>}</label>
      {textarea ? <textarea rows={6} {...props} /> : <input {...props} />}
      {error && <p className="error" id={errorId}>{error}</p>}
    </div>
  );
}
