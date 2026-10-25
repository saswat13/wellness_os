"""Offline artifact assembly/verification; dependencies must be installed first.

Run pip's cross-platform install from README, then this script. Never invokes AWS.
"""

import shutil
import struct
from pathlib import Path


def main():
    backend = Path(__file__).resolve().parents[1]
    destination = backend / "lambda-dist"
    if not (destination / "pydantic_core").is_dir():
        raise SystemExit("Install pinned arm64 dependencies into lambda-dist first; see README")
    package = destination / "form_backend"
    if package.exists():
        shutil.rmtree(package)
    shutil.copytree(
        backend / "form_backend",
        package,
        ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "local_sessions.py"),
    )
    native = list(destination.rglob("*.so"))
    if not native:
        raise SystemExit("Missing native dependencies")
    for extension in native:
        header = extension.read_bytes()[:20]
        if header[:4] != b"\x7fELF" or struct.unpack("<H", header[18:20])[0] != 183:
            raise SystemExit("Non-AArch64 extension: " + str(extension.relative_to(destination)))
    for cache in destination.rglob("__pycache__"):
        shutil.rmtree(cache)
    print(f"Assembled Python 3.13 asset; {len(native)} ELF AArch64 extensions verified")
    print("AArch64 execution and Lambda cold starts still require controlled AWS verification")


if __name__ == "__main__":
    main()
