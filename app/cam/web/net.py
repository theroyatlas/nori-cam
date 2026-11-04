"""HTTPS defaults for urllib clients for read-only web helpers (certifi CA bundle when available)."""
import ssl
import urllib.request


def ssl_context():
    try:
        import certifi

        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        return ssl.create_default_context()


def default_urlopen(req, *args, **kwargs):
    if 'context' not in kwargs:
        kwargs['context'] = ssl_context()
    return urllib.request.urlopen(req, *args, **kwargs)
