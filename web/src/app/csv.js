/**
 * Delimited text (RFC 4180): quoted fields may hold the separator, doubled quotes and line breaks.
 * `cut` says the text is the start of a longer file, so a record still open at the end is dropped, not guessed.
 * Returns { rows, partial } where `partial` is true when a trailing record was dropped.
 */
export function parseDelimited(text, { separator = ',', maxRows = Infinity, cut = false } = {}) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const endField = () => { row.push(field); field = ''; };
  const endRow = () => { endField(); rows.push(row); row = []; };
  while (i < text.length && rows.length < maxRows) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i += 2; continue; }
      if (c === '"') { quoted = false; i += 1; continue; }
      field += c; i += 1; continue;
    }
    if (c === '"' && field === '') { quoted = true; i += 1; continue; }
    if (c === separator) { endField(); i += 1; continue; }
    if (c === '\r' && text[i + 1] === '\n') { endRow(); i += 2; continue; }
    if (c === '\n' || c === '\r') { endRow(); i += 1; continue; }
    field += c; i += 1;
  }
  if (rows.length >= maxRows) return { rows, partial: i < text.length };
  // Text ended mid-record: keep it only when the whole file was read and no quote is left open.
  if (field !== '' || row.length) {
    if (cut || quoted) return { rows, partial: true };
    endRow();
  }
  return { rows, partial: cut };
}
