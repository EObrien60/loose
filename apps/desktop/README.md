# @loose/desktop

Electron desktop shell that wraps the Loose web client.

In **dev** it loads the Vite dev server at `http://localhost:5173`; in a **packaged** build it loads the web app's static files from `../web/dist/index.html`. Dev vs prod is decided by `app.isPackaged` (and the `ELECTRON_DEV=1` env var set by the `dev` script).

## Running

Start the web dev server in one terminal, then launch the desktop shell in another:

```sh
pnpm dev:web                      # from the repo root — serves http://localhost:5173
pnpm --filter @loose/desktop dev  # compiles main/preload and launches Electron
```

For a production-style run, first build the web app (`pnpm --filter @loose/web build`), then build and run the desktop shell unpackaged, or package it with electron-builder using the `build` config in `package.json`.
