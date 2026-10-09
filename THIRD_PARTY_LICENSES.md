# Third-party licenses

Dependencies currently recorded in `package.json` and `package-lock.json`, plus the reviewed KDBX transitive dependencies:

| Package                | Locked version | License      |
| ---------------------- | -------------: | ------------ |
| `react`                |         19.3.0 | MIT          |
| `react-dom`            |         19.3.0 | MIT          |
| `zod`                  |          4.6.5 | MIT          |
| `hash-wasm`            |         4.12.0 | MIT          |
| `kdbxweb`              |          2.1.1 | MIT          |
| `@xmldom/xmldom`       |         0.8.15 | MIT          |
| `fflate`               |          0.7.5 | MIT          |
| `ssh2`                 |         1.17.0 | MIT          |
| `@xterm/xterm`         |          6.0.0 | MIT          |
| `@xterm/addon-fit`     |         0.11.0 | MIT          |
| `asn1`                 |          0.2.6 | MIT          |
| `bcrypt-pbkdf`         |          1.0.2 | BSD-3-Clause |
| `cpu-features`         |         0.0.10 | MIT          |
| `nan`                  |         2.29.0 | MIT          |
| `@eslint/js`           |         10.0.1 | MIT          |
| `@types/node`          |         26.6.4 | MIT          |
| `@types/react`         |         19.3.0 | MIT          |
| `@types/react-dom`     |         19.3.0 | MIT          |
| `@types/ssh2`          |         1.15.6 | MIT          |
| `@vitejs/plugin-react` |          5.2.0 | MIT          |
| `electron`             |         44.5.1 | MIT          |
| `electron-vite`        |          5.0.0 | MIT          |
| `eslint`               |        10.12.0 | MIT          |
| `globals`              |        17.13.0 | MIT          |
| `prettier`             |          3.9.9 | MIT          |
| `typescript`           |          6.0.3 | Apache-2.0   |
| `typescript-eslint`    |         8.71.1 | MIT          |
| `vite`                 |          7.3.7 | MIT          |
| `vitest`               |          5.0.3 | MIT          |

The `@xmldom/xmldom` entry is a pinned transitive override. `kdbxweb` requests an earlier vulnerable 0.7.x range; the override uses the latest patched 0.8 release to retain the parser API expected by kdbxweb. `fflate` is another `kdbxweb` dependency. `asn1`, `bcrypt-pbkdf`, and the optional `cpu-features`/`nan` packages are `ssh2` dependencies. `cpu-features` is an optional native optimization used to select default ciphers; `ssh2` catches its unavailability and falls back to its JavaScript path. It may be unavailable when its native addon cannot be built for a platform or Electron ABI.

Licenses above were read from the installed packages' published `package.json` metadata. They are not a complete transitive-dependency notice. Re-audit the full lockfile and include required notices before distributing releases.

An installed-tree metadata scan covered the 200 installed package versions in the Phase 1 dependency tree. The only license outside the MIT/Apache-2.0/ISC/BSD/0BSD/Unlicense/BlueOak allowlist was `caniuse-lite` (`CC-BY-4.0`), a build-time browser-compatibility data package. Preserve its required attribution in any redistribution and re-review this exception before release.

## electron-builder 26.15.3 (devDependency)
MIT. Packaging tool only; not shipped in the app. `npm audit` reports 8 moderate findings in its toolchain (dev only).

## simple-icons (dependency)
CC0-1.0. Provides the OS/distribution logo paths shown on host cards. The logos themselves are trademarks of their respective owners and are used only to identify the operating system; TunnelNote is not affiliated with or endorsed by them.
