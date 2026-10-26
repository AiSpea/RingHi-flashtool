"""Public release checks; only Python-native bundles are eligible for replacement."""

import hashlib, os, re, sys, tempfile, zipfile, subprocess
from pathlib import Path
from urllib.parse import urlparse
import requests
from . import __version__

REPO = "AiSpea/RingHi-flashtool"


def version(s):
    if not re.fullmatch(r"v?\d+\.\d+\.\d+", s):
        return (0, 0, 0)
    return tuple(map(int, s.lstrip("v").split(".")))


def allowed(url):
    p = urlparse(url)
    return (
        p.scheme == "https"
        and p.hostname == "github.com"
        and p.path.startswith("/" + REPO + "/releases/download/")
    )


def direct_session():
    session = requests.Session()
    session.trust_env = False
    return session


def check():
    with direct_session() as session:
        return _check(session)


def _check(session):
    r = session.get(
        "https://api.github.com/repos/" + REPO + "/releases/latest",
        headers={"Accept": "application/vnd.github+json"},
        timeout=(8, 15),
    )
    r.raise_for_status()
    release = r.json()
    if version(release.get("tag_name", "")) <= version(__version__):
        return None
    assets = release.get("assets", [])
    asset = next(
        (
            a
            for a in assets
            if re.fullmatch(r"RingHi-Python-\d+\.\d+\.\d+-win-x64\.zip", a["name"])
        ),
        None,
    )
    hashes = next((a for a in assets if a["name"] == "SHA256SUMS.txt"), None)
    if not asset or not hashes:
        return None
    if not all(allowed(a["browser_download_url"]) for a in (asset, hashes)):
        raise ValueError("更新资产来源不符合预期")
    return {
        "version": release["tag_name"],
        "asset": asset,
        "hashes": hashes,
        "page": release["html_url"],
    }


def download(info):
    with direct_session() as session:
        return _download(info, session)


def _download(info, session):
    sums = session.get(info["hashes"]["browser_download_url"], timeout=(8, 30))
    sums.raise_for_status()
    if len(sums.content) > 65536:
        raise ValueError("校验清单过大")
    name = info["asset"]["name"]
    expected = None
    for line in sums.text.splitlines():
        fields = line.split()
        if (
            len(fields) == 2
            and fields[1].lstrip("*") == name
            and re.fullmatch("[a-fA-F0-9]{64}", fields[0])
        ):
            expected = fields[0].lower()
    if expected is None:
        raise ValueError("更新包缺少 SHA-256")
    folder = Path(tempfile.mkdtemp(prefix="RingHi-update-"))
    archive = folder / name
    with session.get(
        info["asset"]["browser_download_url"], stream=True, timeout=(8, 30)
    ) as r:
        r.raise_for_status()
        total = 0
        with archive.open("wb") as f:
            for part in r.iter_content(1024 * 1024):
                total += len(part)
                if total > 400 * 1024 * 1024:
                    raise ValueError("更新包超出大小限制")
                f.write(part)
    if hashlib.sha256(archive.read_bytes()).hexdigest() != expected:
        raise ValueError("更新包 SHA-256 不匹配")
    target = folder / "unpacked"
    target.mkdir()
    with zipfile.ZipFile(archive) as z:
        if sum(i.file_size for i in z.infolist()) > 1024 * 1024 * 1024:
            raise ValueError("更新包解压大小超限")
        for i in z.infolist():
            path = (target / i.filename).resolve()
            if (
                not path.is_relative_to(target.resolve())
                or (i.external_attr >> 16) & 0xF000 == 0xA000
            ):
                raise ValueError("更新包路径异常")
        z.extractall(target)
    exe = list(target.glob("*/RingHi.exe"))
    if len(exe) != 1 or not (exe[0].parent / "_internal").is_dir():
        raise ValueError("更新包不是完整 Python 原生版本")
    return exe[0].parent


def launch_replace(staged):
    if not getattr(sys, "frozen", False):
        raise ValueError("请在安装后的应用中更新")
    dest = Path(sys.executable).parent
    if str(dest).startswith(str(Path(tempfile.gettempdir()))):
        raise ValueError("请将应用安装到固定目录后更新")

    def quote(v):
        return "'" + str(v).replace("'", "''") + "'"

    script = Path(tempfile.mkdtemp(prefix="RingHi-install-")) / "replace.ps1"
    body = f"""$ErrorActionPreference='Stop'
Wait-Process -Id {os.getpid()} -ErrorAction SilentlyContinue
$src={quote(staged)}
$dst={quote(dest)}
$backup=Join-Path $env:LOCALAPPDATA ('RingHi-backups/'+(Get-Date -Format yyyyMMddHHmmss))
New-Item -ItemType Directory -Force $backup|Out-Null
Copy-Item "$dst/*" $backup -Recurse -Force
try {{
 Copy-Item "$src/*" $dst -Recurse -Force
 Start-Process "$dst/RingHi.exe"
}} catch {{
 Copy-Item "$backup/*" $dst -Recurse -Force
 Start-Process "$dst/RingHi.exe"
 throw
}}
"""
    script.write_text(body, encoding="utf-8-sig")
    subprocess.Popen(
        [
            "powershell",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(script),
        ],
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
