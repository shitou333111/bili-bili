# Manual Publishing Guide

This document describes how to manually publish the Rust crate (crates.io) and the npm package (guest JS client) for `tauri-plugin-pldownloader`.

## Prerequisites

- Versions set to the same release number:
  - `Cargo.toml` → `[package] version = "1.0.0"`
  - `package.json` → `"version": "1.0.0"`
- Clean git tree on `main`.
- Accounts and tokens:
  - crates.io account (`cargo login` done locally once)
  - npm account with 2FA as needed (`npm login`)

## 1) Publish Rust crate (crates.io)

1. Verify package builds:
   ```bash
   cargo publish --dry-run
   ```
2. Publish:
   ```bash
   cargo publish
   ```
3. Wait for crates.io indexing (usually a few minutes).

## 2) Publish npm package (guest-js)

1. Install deps and build:
   ```bash
   corepack enable
   yarn install
   yarn build
   ```
2. Verify the output in `dist-js/` contains `index.js`, `index.cjs`, and `index.d.ts`.
3. Publish:
   ```bash
   npm publish --access public
   ```

## 3) Tag release in git (optional but recommended)

```bash
git commit -am "chore(release): v1.0.0"
git tag v1.0.0
git push
git push origin v1.0.0
```

## 4) Post-publish checks

- crates.io: https://crates.io/crates/tauri-plugin-pldownloader
- npm: `npm info tauri-plugin-pldownloader-api`
- Update README badges/links if needed.

## Notes

- The `.github/workflows/release.yml` is disabled; publishing is manual as per this guide.
- Ensure cross-platform data consistency across TypeScript, Rust, and native bindings when bumping versions (see repo rules).
