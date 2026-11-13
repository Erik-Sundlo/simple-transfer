# Simple Transfer

A small macOS desktop client for SFTP, FTP, and FTPS. Browse local and remote
folders side by side, select files, and upload or download them.

## Run

Requires Node.js 22 or newer and npm.

```sh
npm ci
npm start
```

```sh
npm test
npm run check
npm run smoke
npm run smoke:ui
npm run pack
```

`npm run pack` produces `dist/mac-arm64/Simple Transfer.app` on Apple Silicon
(or `dist/mac/Simple Transfer.app` on Intel). `npm run dist` builds a DMG.
Builds are unsigned and not notarized; distributing them to other Macs requires
your own Apple signing identity and notarization.

## Use

1. Choose SFTP, FTP, or FTPS, then enter host, port, and username.
2. For SFTP, choose password or a private SSH key (and its passphrase if needed).
3. Choose **Save connection** to save without connecting. All saved connections
   are displayed at the top on launch. Single-click one to load or edit it;
   double-click it (or focus it and press Enter) to connect using saved credentials.
   **New connection** clears the form; saving a selected entry updates it.
4. Connect. Check an unfamiliar SSH server's fingerprint before trusting it.
   Leave "Remember login and SSH key" checked to save the connection. Passwords,
   imported private keys, and passphrases are encrypted using macOS
   Keychain-backed encryption. The original key file is no longer needed after
   saving. Select a saved connection to reconnect; leave secret fields blank to
   reuse the saved values. Choose Forget to remove a saved login and its secrets.
5. Open folders with a click on their name, or double-click their row. Paths are
   editable; press Enter or Go to navigate. Hidden files are shown.
6. Select files with checkboxes. Upload sends them to the remote pane's folder;
   Download saves them into the local pane's folder.

Replacing an existing file requires confirmation. Downloads use a temporary file
and only replace the destination after completion. Uploads write directly to the
remote file, so an interrupted upload may leave a partial remote file.
Disconnect stops the active transfer. Folder transfers, synchronization, deletion,
and file editing are intentionally not included.

## SSH tunnels

For SFTP through an existing SSH dynamic-forward tunnel (`ssh -D`), enable
**Use SSH tunnel (SOCKS5)** and enter the tunnel's local proxy address and port.
Keep the destination server's hostname and SSH port in the normal connection
fields. Hostname resolution happens at the proxy, so internal-only hostnames
work. Proxy settings are saved with the connection. The app does not automatically
use macOS browser proxy/PAC settings or start/manage the SSH tunnel itself.

For a local port forward (`ssh -L`), leave SOCKS5 disabled and connect to
`127.0.0.1` with the forwarded local port instead.

Connection stages are displayed in the status bar. SSH and SOCKS5 negotiation,
SFTP subsystem startup, and directory requests have bounded waits. Disconnect
also cancels an in-progress tunnel connection. SOCKS5 currently supports
unauthenticated proxies for SFTP only; FTP/FTPS continue to connect directly.

## Connection safety

- Saved passwords, imported private keys, and key passphrases are encrypted with
  Electron `safeStorage`, backed by macOS Keychain. The encrypted credentials
  and non-secret connection settings live in `connections.json` in Electron's
  macOS Application Support directory. Plain-text private keys are never copied
  into that directory, and secrets are never sent back to the renderer.
- Saving fails closed if Keychain encryption is unavailable. Uncheck "Remember
  login and SSH key" for a one-off connection. Saved secrets are only reused for
  the same protocol, host, port, username, and authentication method.
- Connection metadata (names, hostnames, usernames) and trusted SSH fingerprints
  are not encrypted. Forget removes the saved entry; it does not promise secure
  erasure of backups or filesystem snapshots.
- New SSH identities require approval; changed identities are blocked. Only use
  Connection > Forget trusted SSH hosts after independently verifying a change.
- FTPS requires a valid, trusted TLS certificate and TLS 1.2 or newer. Explicit
  FTPS normally uses port 21; implicit FTPS normally uses port 990.
- Plain FTP is unencrypted and requires confirmation before connecting.
- The renderer has no Node.js access and cannot load external resources.
