import hashlib
from ringhi import updates


def test_update_check_and_download_ignore_all_environment_proxies(
    monkeypatch, tmp_path
):
    for key in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy"):
        monkeypatch.setenv(key, "http://127.0.0.1:1")
    payload = b"MZ-installer-fixture"
    name = "RingHi-Setup-99.0.0-win-x64.exe"
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
    assert staged.read_bytes() == payload
    assert len(calls) == 3 and all(not proxy for _, proxy in calls)
    assert len(sessions) == 2 and all(s.closed for s in sessions)


def test_release_does_not_mix_version_or_old_zip_assets():
    class Reply:
        def raise_for_status(self):
            pass

        def json(self):
            return {
                "tag_name": "v99.0.0",
                "assets": [
                    {"name": "RingHi-Setup-98.0.0-win-x64.exe"},
                    {"name": "RingHi-Python-99.0.0-win-x64.zip"},
                    {"name": "SHA256SUMS.txt"},
                ],
            }

    class Session:
        def get(self, *a, **kw):
            return Reply()

    assert updates._check(Session()) is None


def test_download_rejects_untrusted_source_before_network():
    import pytest

    with pytest.raises(ValueError, match="来源"):
        updates._download(
            {
                "asset": {"browser_download_url": "https://evil.test/setup.exe"},
                "hashes": {"browser_download_url": "https://evil.test/sums"},
            },
            None,
        )


def test_installer_helper_waits_saves_and_relaunches(tmp_path):
    exe = tmp_path / "setup.exe"
    exe.write_bytes(b"MZfixture")
    body = updates.installer_script(
        exe, "C:/Users/test/it's RingHi", 123, tmp_path / "ready", tmp_path / "log"
    )
    assert "it''s RingHi" in body
    assert "WaitForExit(300000)" in body and "Stop-Process" not in body
    assert (
        body.index("WaitForExit")
        < body.index("Get-FileHash")
        < body.index("$setup=Start-Process")
    )
    assert body.index("$setup.ExitCode") < body.index("$dst+'/RingHi.exe'")
    assert "/NORESTART" in body and "PYINSTALLER_RESET_ENVIRONMENT" in body
