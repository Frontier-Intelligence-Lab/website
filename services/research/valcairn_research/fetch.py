"""Bounded public HTTPS retrieval for one research run.

The worker has no database credentials and no shell. It refuses private, loopback,
link-local and reserved addresses after DNS resolution, follows a few HTTPS redirects
only when the next hop passes the same check, and keeps a size cap. Retrieved text is
data, never instructions.
"""

from __future__ import annotations

import hashlib
import ipaddress
import json
import socket
import ssl
import sys
from datetime import datetime, timezone
from html.parser import HTMLParser
from http import client as http_client
from urllib.parse import quote, urlsplit, urlunsplit

MAX_URLS = 5
MAX_BYTES = 150_000
MAX_HOPS = 3
TIMEOUT = 8

class UnsafeUrl(Exception):
    pass


def blocked_ip(value):
    try:
        ip = ipaddress.ip_address(value)
    except ValueError:
        return True
    # is_global is false for shared CGNAT (100.64.0.0/10), which is_private does not cover.
    # Multicast can still report is_global, so it stays in the list.
    return any([
        ip.is_private, ip.is_loopback, ip.is_link_local, ip.is_multicast,
        ip.is_reserved, ip.is_unspecified, not ip.is_global,
    ])


def public_addresses(hostname):
    host = (hostname or '').strip().rstrip('.').lower()
    if not host or host in {'localhost', 'metadata', 'metadata.google.internal'} or host.endswith('.local') or host.endswith('.internal'):
        raise UnsafeUrl('That host is not a public source.')
    try:
        literal = ipaddress.ip_address(host)
    except ValueError:
        literal = None
    if literal is not None:
        if blocked_ip(literal):
            raise UnsafeUrl('That address is not a public source.')
        return [str(literal)]
    try:
        infos = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise UnsafeUrl('The host did not resolve.') from exc
    addresses = []
    for info in infos:
        address = info[4][0]
        if blocked_ip(address):
            raise UnsafeUrl('The host resolves to a non-public address.')
        if address not in addresses:
            addresses.append(address)
    if not addresses:
        raise UnsafeUrl('The host did not resolve.')
    return addresses


def _load_windows_roots(context):
    """Add the Windows ROOT store. Standalone CPython bundles an older CA list and
    rejects current public issuers. Hostname checks and certificate verification stay on.
    """
    if sys.platform != 'win32':
        return
    import ctypes
    from ctypes import wintypes
    crypt32 = ctypes.WinDLL('crypt32', use_last_error=True)

    class CertContext(ctypes.Structure):
        _fields_ = (
            ('dwCertEncodingType', wintypes.DWORD),
            ('pbCertEncoded', ctypes.POINTER(ctypes.c_byte)),
            ('cbCertEncoded', wintypes.DWORD),
            ('pCertInfo', ctypes.c_void_p),
            ('hCertStore', ctypes.c_void_p),
        )

    crypt32.CertOpenSystemStoreW.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p]
    crypt32.CertOpenSystemStoreW.restype = ctypes.c_void_p
    crypt32.CertEnumCertificatesInStore.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    crypt32.CertEnumCertificatesInStore.restype = ctypes.POINTER(CertContext)
    crypt32.CertCloseStore.argtypes = [ctypes.c_void_p, wintypes.DWORD]
    crypt32.CertCloseStore.restype = wintypes.BOOL
    store = crypt32.CertOpenSystemStoreW(None, 'ROOT')
    if not store:
        return
    pems = []
    cert = crypt32.CertEnumCertificatesInStore(store, None)
    while cert:
        encoded = ctypes.string_at(cert.contents.pbCertEncoded, cert.contents.cbCertEncoded)
        pems.append(ssl.DER_cert_to_PEM_cert(encoded))
        cert = crypt32.CertEnumCertificatesInStore(store, cert)
    crypt32.CertCloseStore(store, 0)
    if pems:
        context.load_verify_locations(cadata=''.join(pems))


def ssl_context():
    context = ssl.create_default_context()
    _load_windows_roots(context)
    return context


SSL_CONTEXT = ssl_context()


class _PinnedConnection(http_client.HTTPSConnection):
    def connect(self):
        addresses = public_addresses(self.host)
        raw = socket.create_connection((addresses[0], 443), self.timeout)
        self.sock = self._context.wrap_socket(raw, server_hostname=self.host)


class _Text(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self.title = []
        self.skip = 0
        self.in_title = False

    def handle_starttag(self, tag, attrs):
        if tag in {'script', 'style', 'noscript'}:
            self.skip += 1
        if tag == 'title':
            self.in_title = True

    def handle_endtag(self, tag):
        if tag in {'script', 'style', 'noscript'} and self.skip:
            self.skip -= 1
        if tag == 'title':
            self.in_title = False

    def handle_data(self, data):
        if self.skip:
            return
        if self.in_title:
            self.title.append(data)
        else:
            self.parts.append(data)


def _clean(value, limit):
    text = ' '.join((value or '').split())
    return text[:limit]


def text_from_body(body, content_type):
    kind = (content_type or '').split(';', 1)[0].strip().lower()
    if kind not in {'text/html', 'text/plain', 'application/json', 'application/xhtml+xml'}:
        raise UnsafeUrl('The response is not HTML, plain text or JSON.')
    decoded = body.decode('utf-8', errors='replace')
    if kind == 'text/html' or kind == 'application/xhtml+xml':
        parser = _Text()
        parser.feed(decoded)
        title = _clean(''.join(parser.title), 200)
        text = _clean(' '.join(parser.parts), 8000)
        return title, text
    if kind == 'application/json':
        return '', _clean(decoded, 8000)
    return '', _clean(decoded, 8000)


def _request(url, timeout, max_bytes):
    parts = urlsplit(url)
    if parts.scheme != 'https' or parts.username or parts.password or parts.hostname is None:
        raise UnsafeUrl('Only https URLs without a username or password are fetched.')
    if parts.port not in (None, 443):
        raise UnsafeUrl('Only port 443 is fetched.')
    public_addresses(parts.hostname)
    path = parts.path or '/'
    if parts.query:
        path = f'{path}?{parts.query}'
    connection = _PinnedConnection(parts.hostname, timeout=timeout, context=SSL_CONTEXT)
    try:
        connection.request('GET', path, headers={
            'Host': parts.hostname,
            'User-Agent': 'ValcairnResearch/1',
            'Accept': 'text/html,application/json,text/plain',
            'Accept-Encoding': 'identity',
        })
        response = connection.getresponse()
        body = response.read(max_bytes + 1)
        if len(body) > max_bytes:
            raise UnsafeUrl('The response is larger than the run allows.')
        return response.status, response.getheader('Location'), response.getheader('Content-Type'), body
    finally:
        connection.close()


def fetch_page(url, timeout=TIMEOUT, max_bytes=MAX_BYTES):
    current = url
    try:
        for _hop in range(MAX_HOPS + 1):
            status, location, content_type, body = _request(current, timeout, max_bytes)
            if status in {301, 302, 303, 307, 308}:
                if not location:
                    raise UnsafeUrl('A redirect had no location.')
                nxt = location if location.startswith('https://') else ''
                if not nxt:
                    raise UnsafeUrl('A redirect left https.')
                current = urlunsplit(urlsplit(nxt)[:5])
                continue
            if status != 200:
                return _failed(url, current, 'inaccessible' if status in {401, 403, 429} else 'failed', f'HTTP {status}', status)
            title, text = text_from_body(body, content_type)
            if not text:
                return _failed(url, current, 'failed', 'The page had no text to quote.', status)
            digest = hashlib.sha256(text.encode('utf-8')).hexdigest()
            return {
                'url': url, 'finalUrl': current, 'status': 'retrieved', 'httpStatus': status,
                'title': title, 'text': text, 'excerpt': text[:1500], 'sha256': digest,
                'failure': None, 'publisher': urlsplit(current).hostname,
                'retrievedAt': datetime.now(timezone.utc).isoformat(),
            }
        return _failed(url, current, 'failed', 'Too many redirects.', None)
    except UnsafeUrl as exc:
        return _failed(url, current, 'failed', str(exc), None)
    except (TimeoutError, socket.timeout, ssl.SSLError, OSError, http_client.HTTPException):
        return _failed(url, current, 'inaccessible', 'The source could not be retrieved.', None)


def _failed(url, final, status, failure, http_status):
    return {
        'url': url, 'finalUrl': final, 'status': status, 'httpStatus': http_status,
        'title': '', 'text': '', 'excerpt': '', 'sha256': None, 'failure': failure[:500],
        'publisher': '', 'retrievedAt': datetime.now(timezone.utc).isoformat(),
    }


def wikimedia_urls(question, limit):
    query = quote(question.strip()[:200])
    page = fetch_page(
        f'https://en.wikipedia.org/w/api.php?action=opensearch&limit={limit}&namespace=0&format=json&search={query}',
        timeout=TIMEOUT, max_bytes=MAX_BYTES,
    )
    if page['status'] != 'retrieved':
        return []
    try:
        payload = json.loads(page['text'][:MAX_BYTES])
    except json.JSONDecodeError:
        return []
    urls = payload[3] if isinstance(payload, list) and len(payload) > 3 and isinstance(payload[3], list) else []
    return [url for url in urls if isinstance(url, str) and url.startswith('https://')][:limit]


def _max_urls(limit):
    try:
        requested = int(limit.get('maxUrls') or 3)
    except (TypeError, ValueError):
        requested = 3
    return max(1, min(MAX_URLS, requested))


def collect(payload):
    question = str(payload.get('question') or '')
    requested = payload.get('urls') if isinstance(payload.get('urls'), list) else []
    limit = payload.get('limits') if isinstance(payload.get('limits'), dict) else {}
    max_urls = _max_urls(limit)
    # Only the public Wikimedia API is optional. Any other search value is ignored.
    search = payload.get('search')
    # Named URLs are the permission the user granted. Wikimedia only fills slots they left open.
    urls = []
    for url in requested:
        if isinstance(url, str) and url not in urls:
            urls.append(url)
    if search == 'wikimedia' and question.strip() and len(urls) < max_urls:
        for url in wikimedia_urls(question, max_urls - len(urls)):
            if url not in urls:
                urls.append(url)
    pages = [fetch_page(url) for url in urls[:max_urls]]
    return {'pages': pages}
