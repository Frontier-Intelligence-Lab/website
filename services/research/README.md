# Valcairn research worker

Fetches public HTTPS pages for one research run. The Fastify API starts it and stores the result. The worker has no database credentials, no shell, and no runner or GPU authority. It is not the saved-note Agent and it is not a training job.

| | |
| --- | --- |
| Status | Implemented. Not deployed. |
| Language | Python 3.11 or later, standard library only |
| Search | Public Wikimedia opensearch, only when the payload says `search: "wikimedia"` |
| Paid search | Not called |

## Run

From `services/research`:

```powershell
python -m valcairn_research
```

Write one JSON object to stdin: `question`, `urls`, `search` (`wikimedia` or anything else, which means no search), and `limits.maxUrls` (at most 5). Stdout is `{ "pages": [...] }`. A refused URL is a page with status `failed` or `inaccessible` and empty text. Exit code 2 means the stdin JSON was unusable. Retrieved HTML is parsed as text. Script and style contents are dropped. The text is data, not instructions.

The process refuses hosts that resolve to loopback, private, shared (100.64.0.0/10), link-local, multicast, reserved, unspecified, or non-global addresses, and it refuses `localhost`, `.local`, `.internal` and the cloud metadata name. It connects to the resolved public address with the original name as the TLS server name. Certificate verification and hostname checks stay on. On Windows it also trusts the operating-system root store, because a standalone Python build can ship an older CA list. HTTPS only, port 443, no userinfo, at most 3 redirects, about 150 KB, 8 second timeout.

## Tests

```powershell
python -m unittest discover -s tests
```

Run that from `services/research`. The tests do not contact the network.

## License

No separate license file is checked in for this worker. It follows the repository it ships in.
