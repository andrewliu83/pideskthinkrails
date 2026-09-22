# reference/

Copies of upstream PI-Desktop files this plugin is pinned to, so a test can fail when they drift.

- `appearance/appearance-boot.js`, `appearance/appearance.js` — the canonical appearance adapter from
  `pi-desktop-plugins/plugins/shared/appearance/renderer/`. The plugin ships byte-identical copies in
  `plugins/pi.thinkrail/renderer/`; the test compares them.
- `scripts/pack_plugin.py`, `scripts/security_audit.py` at the repository root are unmodified copies of
  the marketplace tooling (`pi-desktop-plugins/scripts/`), used to pack and preflight this plugin
  exactly the way a release would.

These files are not part of the plugin package (`pack_plugin.py` only packs `plugins/<id>/`).
