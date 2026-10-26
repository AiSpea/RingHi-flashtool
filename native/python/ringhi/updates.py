"""Public release checks; only Python-native bundles are eligible for replacement."""

import hashlib, os, re, sys, tempfile, zipfile, subprocess, time
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
    release_version = release["tag_name"].lstrip("v")
    # Select only this exact release's Windows-native installer. ZIP remains
    # published for 0.5.5 and older clients that cannot consume EXE installers.
    asset = next(
        (
            a
            for a in assets
            if a["name"] == f"RingHi-Setup-{release_version}-win-x64.exe"
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
    if not all(allowed(info[k]["browser_download_url"]) for k in ("asset", "hashes")):
        raise ValueError("更新资产来源不符合预期")
    if not re.fullmatch(
        r"RingHi-(?:Setup-\d+\.\d+\.\d+-win-x64\.exe|Python-\d+\.\d+\.\d+-win-x64\.zip)",
        info["asset"]["name"],
    ):
        raise ValueError("更新包名称无效")
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
    if name.endswith(".exe"):
        if archive.read_bytes()[:2] != b"MZ":
            raise ValueError("更新包不是 Windows 安装程序")
        return archive
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


def installer_script(installer, dest, pid, ready, log):
    def quote(value):
        return "'" + str(value).replace("'", "''") + "'"

    digest = hashlib.sha256(Path(installer).read_bytes()).hexdigest()
    return f"""$ErrorActionPreference='Stop'
$src={quote(installer)}
$dst={quote(dest)}
$log={quote(log)}
try {{
 $parent=Get-Process -Id {pid} -ErrorAction SilentlyContinue
 [IO.File]::WriteAllText({quote(ready)}, 'ready')
 if($parent -and -not $parent.WaitForExit(300000)){{throw 'RingHi has not finished saving. Update cancelled.'}}
 if((Get-FileHash $src -Algorithm SHA256).Hash.ToLower() -ne '{digest}'){{throw 'Installer checksum changed'}}
 $env:PYINSTALLER_RESET_ENVIRONMENT='1'
 $arguments=@('/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART',('/DIR="'+$dst+'"'),('/LOG="'+$log+'"'))
 $setup=Start-Process -FilePath $src -ArgumentList $arguments -PassThru -Wait
 if($setup.ExitCode -ne 0){{throw ('Installer failed: '+$setup.ExitCode)}}
 Start-Process -FilePath ($dst+'/RingHi.exe') -WorkingDirectory $dst
}} catch {{
 Add-Content -LiteralPath $log -Value $_.Exception.Message
 Add-Type -AssemblyName PresentationFramework
 [System.Windows.MessageBox]::Show('RingHi update did not complete. Open RingHi again or run the downloaded installer. Log: '+$log,'RingHi')|Out-Null
}}
"""


def launch_replace(staged):
    if not getattr(sys, "frozen", False):
        raise ValueError("请在安装后的应用中更新")
    dest = Path(sys.executable).parent
    if dest.resolve().is_relative_to(Path(tempfile.gettempdir()).resolve()):
        raise ValueError("请将应用安装到固定目录后更新")
    staged = Path(staged)
    if not staged.is_file() or staged.suffix.lower() != ".exe":
        raise ValueError("此版本需要 EXE 安装包，请下载新版安装程序")
    folder = Path(tempfile.mkdtemp(prefix="RingHi-install-"))
    script, ready, log = (
        folder / "install.ps1",
        folder / "ready",
        folder / "install.log",
    )
    script.write_text(
        installer_script(staged, dest, os.getpid(), ready, log), encoding="utf-8-sig"
    )
    env = os.environ.copy()
    env["PYINSTALLER_RESET_ENVIRONMENT"] = "1"
    child = subprocess.Popen(
        [
            "powershell.exe",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-WindowStyle",
            "Hidden",
            "-File",
            str(script),
        ],
        env=env,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)
        | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0),
        close_fds=True,
    )
    deadline = time.monotonic() + 8
    while not ready.exists():
        if child.poll() is not None or time.monotonic() > deadline:
            child.terminate()
            raise ValueError("更新助手未启动，应用保持打开，请稍后重试")
        time.sleep(0.05)
