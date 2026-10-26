import hashlib
import io
import zipfile
from ringhi import updates


def test_update_check_and_download_ignore_all_environment_proxies(
    monkeypatch, tmp_path
):
    for key in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy"):
        monkeypatch.setenv(key, "http://127.0.0.1:1")
    data = io.BytesIO()
    with zipfile.ZipFile(data, "w") as z:
        z.writestr("RingHi/RingHi.exe", b"fixture")
        z.writestr("RingHi/_internal/runtime", b"fixture")
    payload = data.getvalue()
    name = "RingHi-Python-99.0.0-win-x64.zip"
    base = "https://github.com/" + updates.REPO + "/releases/download/v99.0.0/"
    assets = [
        dict(name=n, browser_download_url=base + n) for n in (name, "SHA256SUMS.txt")
    ]
    calls, sessions = [], []

    class Response:
        def __init__(self, content=b"", release=None):
            self.content, self.release = content, release
            self.text = content.decode("utf-8", errors="replace")

        def raise_for_status(self):
            pass

        def json(self):
            return self.release

        def iter_content(self, size):
            yield self.content

        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

    class Session:
        trust_env = True

        def __init__(self):
            self.closed = False
            sessions.append(self)

        def get(self, url, **kwargs):
            calls.append((url, self.trust_env))
            if url.endswith("/latest"):
                return Response(
                    release=dict(tag_name="v99.0.0", assets=assets, html_url=base)
                )
            if url.endswith(".txt"):
                return Response(
                    (hashlib.sha256(payload).hexdigest() + "  " + name).encode()
                )
            return Response(payload)

        def __enter__(self):
            return self

        def __exit__(self, *args):
            self.closed = True

    monkeypatch.setattr(updates.requests, "Session", Session)
    monkeypatch.setattr(updates.tempfile, "mkdtemp", lambda **kw: str(tmp_path))
    staged = updates.download(updates.check())
    assert (staged / "RingHi.exe").read_bytes() == b"fixture"
    assert len(calls) == 3 and all(not proxy for _, proxy in calls)
    assert len(sessions) == 2 and all(s.closed for s in sessions)
