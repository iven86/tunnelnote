# Contributing to TunnelNote

Thanks for helping! TunnelNote is free and open source (MIT).

## Setup

```sh
npm ci
npm run dev          # Windows / macOS
npm run dev:linux    # Linux (forces X11)
```

## Before opening a pull request

```sh
npm run lint && npm run typecheck && npm test && npm run build
```

## Guidelines

- Strict TypeScript; validate every IPC payload with zod (`src/shared`).
- The renderer has no Node.js access; privileged work lives in `src/main` behind the preload bridge.
- Never log or persist secrets outside the encrypted vault.
- Platform-specific behavior goes behind small adapters and must be verified on Windows, macOS and Linux (CI runs all three).
- Keep pull requests focused and describe how you tested them.

Report security issues privately — see [SECURITY.md](./SECURITY.md).
