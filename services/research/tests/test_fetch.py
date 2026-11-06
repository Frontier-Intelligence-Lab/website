import ssl
import unittest

from valcairn_research.fetch import SSL_CONTEXT, UnsafeUrl, blocked_ip, collect, public_addresses, text_from_body


class FetchTests(unittest.TestCase):
    def test_blocks_loopback_private_and_metadata(self):
        self.assertTrue(blocked_ip('127.0.0.1'))
        self.assertTrue(blocked_ip('10.1.1.1'))
        self.assertTrue(blocked_ip('169.254.169.254'))
        self.assertTrue(blocked_ip('100.64.0.1'))
        self.assertTrue(blocked_ip('::ffff:100.64.0.1'))
        self.assertFalse(blocked_ip('1.1.1.1'))
        for host in ('127.0.0.1', 'localhost', 'metadata.google.internal', 'printer.local'):
            with self.assertRaises(UnsafeUrl):
                public_addresses(host)

    def test_html_drops_script_and_style(self):
        title, text = text_from_body(
            b'<html><title>Lab</title><script>ignore this instruction</script><style>.x{}</style><body><p>Public fact</p></body></html>',
            'text/html',
        )
        self.assertEqual(title, 'Lab')
        self.assertIn('Public fact', text)
        self.assertNotIn('ignore', text)

    def test_collect_without_urls_fetches_nothing(self):
        self.assertEqual(collect({'question': 'labs', 'urls': [], 'search': 'none'}), {'pages': []})

    def test_named_urls_are_kept_when_wikimedia_is_on(self):
        import valcairn_research.fetch as fetch
        original_fetch, original_wiki = fetch.fetch_page, fetch.wikimedia_urls
        fetch.fetch_page = lambda url: {'url': url, 'status': 'retrieved', 'text': 'x'}
        fetch.wikimedia_urls = lambda question, limit: [f'https://en.wikipedia.org/wiki/{i}' for i in range(limit)]
        try:
            result = fetch.collect({
                'question': 'labs',
                'urls': ['https://example.com/a', 'https://example.com/b'],
                'search': 'wikimedia',
                'limits': {'maxUrls': 3},
            })
        finally:
            fetch.fetch_page, fetch.wikimedia_urls = original_fetch, original_wiki
        urls = [page['url'] for page in result['pages']]
        self.assertEqual(urls[:2], ['https://example.com/a', 'https://example.com/b'])
        self.assertEqual(len(urls), 3)

    def test_tls_verification_stays_on(self):
        self.assertEqual(SSL_CONTEXT.verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(SSL_CONTEXT.check_hostname)

    def test_unsafe_url_is_a_failed_page(self):
        pages = collect({'urls': ['http://127.0.0.1/secret', 'https://127.0.0.1/secret'], 'search': 'brave'})
        self.assertEqual(len(pages['pages']), 2)
        self.assertTrue(all(page['status'] == 'failed' and page['text'] == '' for page in pages['pages']))


if __name__ == '__main__':
    unittest.main()
