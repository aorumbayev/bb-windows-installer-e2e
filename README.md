# bb Windows installer e2e

Installs the real Windows installer of [bb](https://github.com/get-bb/bb) the way a person would, and checks it end to end.

bb's own CI smoke-tests the unpacked Windows app (`win-unpacked`). It does not run the NSIS `.exe` people download. This repo does.

## What it checks

1. The installer's Authenticode signature (warning only).
2. Silent install (`/S`) puts `bb.exe` in `%LOCALAPPDATA%\Programs\bb` and registers an uninstall entry.
3. The app starts its own server: `/health` answers, the host daemon connects, and providers load.
4. Closing the window quits the app, stops the server, and frees both ports.
5. Silent uninstall removes the program files.

The app runs in a throwaway data folder (`BB_DATA_DIR`, `--user-data-dir`) on free ports, so it never touches a real `~/.bb`.

## Run it

GitHub Actions runs it on `windows-2025` on every pull request, daily, and on demand for any `desktop-v*` tag.

On a Windows machine:

```
node e2e.mjs path\to\bb-x.y.z-x64.exe
```

Run it from a logged-in desktop session. Over SSH there is no window to close, so the quit check cannot pass.

## License

MIT
