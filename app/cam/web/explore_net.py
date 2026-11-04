"""Safe read-only web access for the explore task (stdlib only).

Every request goes through Fetcher.get / Fetcher.get_json:
  - GET only, http / https only, ports 80 / 443 only, no credentials, no cookies, no forms;
  - the host is resolved first and refused unless every address is public (SSRF: loopback, private, link-local,
    reserved, multicast, CGNAT all blocked), then the connection is pinned to the checked address (no second DNS lookup);
  - at most 3 redirects, each hop is checked again (scheme, address, robots.txt);
  - robots.txt (RFC 9309, urllib.robotparser) is honoured for pages, with the configured User-Agent;
  - one request per host every `min_interval` seconds;
  - the body is capped (default 2 MB) and only text/html or text/plain pages are accepted.
`opener` and `resolver` are injectable so tests and the offline fake backend never touch the network.
"""
import http.client
import ipaddress
import json
import re
import socket
import time
import urllib.robotparser
from html.parser import HTMLParser
from urllib.parse import urljoin, urlsplit

from . import net

REDIRECTS = (301, 302, 303, 307, 308)
PAGE_TYPES = ('text/html', 'text/plain')
SKIP_TAGS = frozenset({'script', 'style', 'nav', 'footer', 'noscript', 'template', 'svg', 'iframe'})
BLOCK_TAGS = frozenset({'p', 'div', 'br', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'tr', 'section', 'article', 'ul',
                        'ol', 'blockquote', 'pre', 'table'})


class FetchError(Exception):
    """`code` is a short machine-readable reason (blocked_address, robots_disallow, too_large, ...)."""

    def __init__(self, code, detail='', retry_after=None):
        super().__init__(f'{code} {detail}'.strip())
        self.code, self.detail = code, detail
        self.retry_after = retry_after          # the Retry-After header of an HTTP error, as sent (or None)


class Response:
    def __init__(self, url, status, headers, body, truncated=False):
        self.url, self.status, self.headers, self.body, self.truncated = url, status, headers, body, truncated

    @property
    def content_type(self):
        return (self.headers.get('content-type') or '').split(';')[0].strip().lower()

    def text(self):
        ct = self.headers.get('content-type') or ''
        charset = 'utf-8'
        for part in ct.split(';')[1:]:
            k, _, v = part.partition('=')
            if k.strip().lower() == 'charset' and v.strip():
                charset = v.strip().strip('"\'')
        try:
            return self.body.decode(charset, errors='replace')
        except LookupError:
            return self.body.decode('utf-8', errors='replace')


# ---- address checks

def is_public_ip(ip):
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped:
        addr = addr.ipv4_mapped
    return addr.is_global and not addr.is_multicast


def literal_ip(host):
    """The address a literal host stands for, including the legacy numeric forms resolvers expand (2130706433, 0x7f.1)."""
    try:
        return str(ipaddress.ip_address(host))
    except ValueError:
        pass
    if re.fullmatch(r'[0-9a-fx.]+', host, re.I):
        try:
            return socket.inet_ntoa(socket.inet_aton(host))
        except OSError:
            return None
    return None


def system_resolver(host):
    try:
        infos = socket.getaddrinfo(host, None, type=socket.SOCK_STREAM)
    except OSError as e:
        raise FetchError('dns_error', str(e)[:80]) from None
    return list(dict.fromkeys(i[4][0] for i in infos))


# ---- real transport: connects to the checked IP, sends the original Host header / SNI

class _PinnedHTTP(http.client.HTTPConnection):
    def __init__(self, host, port, ip, timeout):
        super().__init__(host, port, timeout=timeout)
        self._ip = ip

    def connect(self):
        self.sock = socket.create_connection((self._ip, self.port), self.timeout)


class _PinnedHTTPS(http.client.HTTPSConnection):
    def __init__(self, host, port, ip, timeout):
        super().__init__(host, port, timeout=timeout, context=net.ssl_context())
        self._ip = ip

    def connect(self):
        sock = socket.create_connection((self._ip, self.port), self.timeout)
        self.sock = self._context.wrap_socket(sock, server_hostname=self.host)


def real_opener(scheme, host, port, ip, path, headers, timeout, max_bytes):
    """-> (status, lower-cased headers, body (at most max_bytes), truncated)."""
    conn = (_PinnedHTTPS if scheme == 'https' else _PinnedHTTP)(host, port, ip, timeout)
    try:
        conn.request('GET', path, headers=headers)
        r = conn.getresponse()
        hdrs = {k.lower(): v for k, v in r.getheaders()}
        body = b'' if r.status in REDIRECTS else r.read(max_bytes + 1)
        return r.status, hdrs, body[:max_bytes], len(body) > max_bytes
    except (OSError, http.client.HTTPException) as e:
        raise FetchError('network_error', type(e).__name__) from None
    finally:
        conn.close()


class Fetcher:
    def __init__(self, user_agent, opener=None, resolver=None, sleep=time.sleep, monotonic=time.monotonic,
                 min_interval=5.0, interval_overrides=None, timeout=20, max_bytes=2_000_000, max_redirects=3):
        if not user_agent:
            raise ValueError('a descriptive User-Agent is required')
        self.ua = user_agent
        self.token = user_agent.split('/')[0].split()[0]          # robots.txt product token, e.g. NoriAIPet
        self.opener, self.resolver = opener or real_opener, resolver or system_resolver
        self.sleep, self.monotonic = sleep, monotonic
        self.min_interval, self.overrides = min_interval, dict(interval_overrides or {})
        self.timeout, self.max_bytes, self.max_redirects = timeout, max_bytes, max_redirects
        self._last, self._robots = {}, {}
        self.requests = []                                         # (method, url) of every request sent, for the record

    # ---- one hop
    def _check_url(self, url, allowed_hosts):
        p = urlsplit(url)
        if p.scheme not in ('http', 'https'):
            raise FetchError('scheme_not_allowed', p.scheme)
        if not p.hostname:
            raise FetchError('bad_url')
        if p.username or p.password or '@' in p.netloc:
            raise FetchError('credentials_in_url')
        try:
            port = p.port or (443 if p.scheme == 'https' else 80)
        except ValueError:
            raise FetchError('bad_url') from None
        if port not in (80, 443):
            raise FetchError('port_not_allowed', str(port))
        host = p.hostname.lower().rstrip('.')
        if allowed_hosts is not None and host not in allowed_hosts:
            raise FetchError('host_not_allowed', host)
        lit = literal_ip(host)
        ips = [lit] if lit else self.resolver(host)
        if not ips or not all(is_public_ip(i) for i in ips):
            raise FetchError('blocked_address', host)
        return p, host, port, ips[0]

    def _wait(self, host):
        gap = self.overrides.get(host, self.min_interval)
        last = self._last.get(host)
        if last is not None:
            delta = gap - (self.monotonic() - last)
            if delta > 0:
                self.sleep(delta)
        self._last[host] = self.monotonic()

    def _once(self, url, accept, allowed_hosts, max_bytes=None):
        p, host, port, ip = self._check_url(url, allowed_hosts)
        path = (p.path or '/') + (('?' + p.query) if p.query else '')
        headers = {'User-Agent': self.ua, 'Accept': accept, 'Accept-Encoding': 'identity', 'Connection': 'close'}
        self._wait(host)
        self.requests.append(('GET', url))
        status, hdrs, body, truncated = self.opener(p.scheme, host, port, ip, path, headers, self.timeout,
                                                    max_bytes or self.max_bytes)
        return Response(url, status, {k.lower(): v for k, v in hdrs.items()}, body, truncated)

    # ---- robots.txt
    def _robots_for(self, p):
        key = f'{p.scheme}://{p.netloc.lower()}'
        if key not in self._robots:
            rp = urllib.robotparser.RobotFileParser()
            try:
                r = self._once(key + '/robots.txt', 'text/plain', None)
                if r.status in (404, 410):
                    self._robots[key] = 'allow'
                elif r.status in (401, 403) or r.status >= 500 or r.status != 200 or r.truncated:
                    self._robots[key] = 'deny'                     # RFC 9309: unreachable / forbidden -> assume disallow
                else:
                    rp.parse(r.text().splitlines())
                    self._robots[key] = rp
            except FetchError as e:
                if e.code in ('blocked_address', 'dns_error', 'credentials_in_url', 'scheme_not_allowed'):
                    raise
                self._robots[key] = 'deny'
        return self._robots[key]

    def robots_allows(self, url):
        p = urlsplit(url)
        rules = self._robots_for(p)
        if rules == 'allow':
            return True
        if rules == 'deny':
            return False
        return rules.can_fetch(self.token, url)

    # ---- public
    def get(self, url, accept='text/html,text/plain', types=PAGE_TYPES, robots=True, allowed_hosts=None, max_bytes=None):
        """Follow up to `max_redirects` redirects, re-checking every hop. Returns a Response with status 200.
        `max_bytes` overrides the body cap for this call (audio downloads)."""
        for hop in range(self.max_redirects + 1):
            p, _, _, _ = self._check_url(url, allowed_hosts)       # address check before anything is sent (incl. robots)
            if robots and not self.robots_allows(url):
                raise FetchError('robots_disallow', p.hostname)
            r = self._once(url, accept, allowed_hosts, max_bytes)
            if r.status in REDIRECTS:
                loc = r.headers.get('location')
                if not loc:
                    raise FetchError('bad_redirect')
                url = urljoin(url, loc)
                continue
            if r.status != 200:
                raise FetchError(f'http_{r.status}', retry_after=r.headers.get('retry-after'))
            if r.truncated:
                raise FetchError('too_large', f'>{max_bytes or self.max_bytes} bytes')
            if types and r.content_type not in types:
                raise FetchError('content_type_not_allowed', r.content_type or 'none')
            r.url = url
            return r
        raise FetchError('too_many_redirects')

    def get_json(self, url, allowed_hosts):
        r = self.get(url, accept='application/json', types=None, robots=False, allowed_hosts=allowed_hosts)
        try:
            return json.loads(r.text())
        except ValueError:
            raise FetchError('bad_json') from None


# ---- html -> (title, text)

class _Extract(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.title, self.parts, self._skip, self._in_title = '', [], 0, False

    def handle_starttag(self, tag, attrs):
        if tag == 'title':
            self._in_title = True
        elif tag in SKIP_TAGS:
            self._skip += 1
        elif tag in BLOCK_TAGS:
            self.parts.append('\n')

    def handle_endtag(self, tag):
        if tag == 'title':
            self._in_title = False
        elif tag in SKIP_TAGS:
            self._skip = max(0, self._skip - 1)
        elif tag in BLOCK_TAGS:
            self.parts.append('\n')

    def handle_data(self, data):
        if self._in_title:
            self.title += data
        elif not self._skip:
            self.parts.append(data)


def extract_text(markup, plain=False):
    """-> (title, text). script / style / nav / footer (and similar) are dropped; whitespace is collapsed."""
    if plain:
        title, raw = '', markup
    else:
        ex = _Extract()
        try:
            ex.feed(markup)
            ex.close()
        except Exception:                                          # html.parser is lenient; never fail on bad markup
            pass
        title, raw = ex.title, ''.join(ex.parts)
    lines = [' '.join(line.split()) for line in raw.splitlines()]
    return ' '.join(title.split()), '\n'.join(l for l in lines if l)
