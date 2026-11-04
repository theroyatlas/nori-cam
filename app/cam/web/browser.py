"""Read-only page URL validation for the world runner."""
from urllib.parse import urljoin, urlsplit

from .explore_net import FetchError, literal_ip

class BrowserError(Exception):
    def __init__(self, code, detail=''):
        super().__init__(f'{code} {detail}'.strip())
        self.code, self.detail = code, detail

def domain_blocked(host, blocked_domains):
    host = (host or '').lower().rstrip('.')
    for raw in blocked_domains or []:
        d = str(raw).lower().lstrip('.')
        if not d:
            continue
        if host == d or host.endswith('.' + d):
            return True
    return False

def validate_browser_url(url, cfg, fetcher):
    """Navigation policy: https only, no literal IPs, ports 80/443, not blocked, robots allowed."""
    p = urlsplit(url)
    if p.scheme != 'https':
        raise BrowserError('scheme_not_allowed', p.scheme or 'none')
    if not p.hostname:
        raise BrowserError('bad_url')
    if p.username or p.password or '@' in p.netloc:
        raise BrowserError('credentials_in_url')
    try:
        port = p.port or 443
    except ValueError:
        raise BrowserError('bad_url') from None
    if port not in (80, 443):
        raise BrowserError('port_not_allowed', str(port))
    host = p.hostname.lower().rstrip('.')
    if literal_ip(host):
        raise BrowserError('blocked_address', host)
    blocked = (cfg.get('browser') or {}).get('blocked_domains') or []
    if domain_blocked(host, blocked):
        raise BrowserError('host_not_allowed', host)
    if fetcher is not None and not fetcher.robots_allows(url):
        raise BrowserError('robots_disallow', host)
    return url
