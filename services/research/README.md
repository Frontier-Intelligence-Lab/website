# Valcairn research worker

Fetches public HTTPS pages for one bounded research execution. This runtime unit packages Python, the Node adapter and the local-only bootstrap CLI. HTTP routes and Research screens are a later unit; none is registered by this change. The worker has no database credentials, no shell, and no runner or GPU authority. It is not the saved-note Agent and it is not a training job.

| | |
| --- | --- |
| Status | Runtime and offline tests implemented. HTTP routes/screens are not included. Deployment is not established by this change. |
| Language | Python 3.11 or later, standard library only |
| Search | Public Wikimedia opensearch, only when the payload says `search: "wikimedia"` |
| Paid search | Not called |

## Run

From `services/research`:

```powershell
python -m valcairn_research
```

Write one JSON object to stdin: `question`, `urls`, `search` (`wikimedia` or anything else, which means no search), and `limits.maxUrls` (at most 5). Stdout is `{ "pages": [...] }`. A refused URL is a page with status `failed` or `inaccessible` and empty text. Exit code 2 means the stdin JSON was unusable. Retrieved HTML is parsed as text. Script and style contents are dropped. The text is data, not instructions.

The process refuses hosts that resolve to loopback, private, shared (100.64.0.0/10), link-local, deprecated site-local (fec0::/10), multicast, reserved, unspecified, or non-global addresses, and it refuses `localhost`, `.local`, `.internal` and the cloud metadata name. It connects to the resolved public address with the original name as the TLS server name. Certificate verification and hostname checks stay on. On Windows it also trusts the operating-system root store, because a standalone Python build can ship an older CA list. HTTPS only, port 443, no userinfo, at most 3 redirects, about 150 KB, 8 second timeout.

The final Docker application image installs Python 3 and sets `RESEARCH_PYTHON=python3`; the migrator image does not install Python. Only the three worker package files and the existing company catalog are copied. No Python model packages or API credentials are installed.

The Node adapter observes an AbortSignal, kills a canceled/timed-out child, handles stdin errors and decodes split UTF-8 output correctly. Its 2MiB cap counts raw bytes. This is a local process boundary, not a hosted job scheduler. No HTTP cancellation route is introduced by this runtime-only unit.

`node scripts/research-bootstrap.js --environment local --workspace <uuid>` is dry-run by default. Its guarded database route must be loopback with a `test` name; `--apply` is a local-test import, never a production bootstrap. It does not fetch pages.

## Tests

```powershell
python -m unittest discover -s tests
```

Run that from `services/research`. The tests do not contact the network.

## License

No separate license file is checked in for this worker. It follows the repository it ships in.
