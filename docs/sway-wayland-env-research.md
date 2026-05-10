---
description: Factual research on clipboard, input simulation, hotkeys, overlays, and audio capture for a native Rust dictation tool on Fedora 43 / Sway (Wayland).
---

# Sway/Wayland Environment Research: Native Rust Dictation Tool

Target: Fedora 43, Sway compositor, pure Wayland session, PipeWire+pipewire-pulse, `foot` terminal.

---

## 1. Auto-Paste Strategy on Sway

### Clipboard via wl-clipboard / arboard

`wl-clipboard` (`wl-copy` / `wl-paste`) works cleanly on Sway. It uses the `zwlr_data_control_v1` protocol, which Sway/wlroots has implemented since early versions. The `arboard` Rust crate supports this protocol when the `wayland-data-control` feature flag is enabled; without it, arboard falls back to X11 via XWayland. The `wl-clipboard-rs` crate (YaLTeR) is a pure-Rust alternative that also targets `zwlr_data_control` and is suited for headless/windowless processes. Both work on Sway in 2026. ([arboard](https://github.com/1Password/arboard), [wl-clipboard-rs](https://github.com/YaLTeR/wl-clipboard-rs))

**Clipboard persistence after process exit**: On Wayland, clipboard content is owned by the source process. When it exits, the content is gone unless a clipboard manager intercepts it first. Fedora's Sway Spin ships `wl-clipboard` and `clipman` by default; `clipman` persists clipboard data across application exits. `wl-clip-persist` is a lighter alternative specifically for this purpose. `cliphist` is another modern option popular in the Sway/Hyprland ecosystem. None of these run by default — the user must start them. ([wl-clip-persist](https://github.com/Linus789/wl-clip-persist), [Fedora discussion](https://discussion.fedoraproject.org/t/clipboard-in-wayland-sway-spin-how-does-it-work/141904))

For a dictation tool that writes to clipboard then pastes: the app is still running when it triggers Ctrl+V, so the "process exits" problem doesn't apply. The clipboard write is safe.

### Input Simulation: enigo

`enigo` 0.6.x (latest stable as of mid-2026) on Linux uses the protocol priority order `wayland > x11 > libei`. The Wayland backend uses `zwp_virtual_keyboard_v1`, the same protocol as `wtype`. A known hang on Sway was fixed (documented in the 0.4.0 changelog). `libei` support exists as a feature flag but remains experimental; the protocol priority was deliberately demoted from first to last because of bugs. The libei path requires `xdg-desktop-portal` RemoteDesktop — which is **not implemented** in `xdg-desktop-portal-wlr` (the issue has been open since 2019 with no implementation). So on Sway, enigo's libei path is a dead end for now. The `wayland` feature (virtual-keyboard protocol) is the usable path. ([enigo](https://github.com/enigo-rs/enigo), [xdg-desktop-portal-wlr RemoteDesktop issue #2](https://github.com/emersion/xdg-desktop-portal-wlr/issues/2))

### Input Simulation: wtype

`wtype` uses `zwp_virtual_keyboard_v1` directly. Sway/wlroots implements this protocol. It is simple, reliable on Sway, and handles Unicode text well. For high-volume text injection (long transcriptions), it is the most straightforward option. ([wtype](https://github.com/atx/wtype))

### Input Simulation: ydotool

`ydotool` works at the kernel level via `/dev/uinput`, bypassing Wayland's security model entirely. It requires the `ydotoold` daemon. On Fedora, access to `/dev/uinput` requires either: adding the user to the `input` group with a udev rule (`KERNEL=="uinput", MODE="0660", GROUP="input"`), or the `uaccess` tag for seat-local access. Recent discussions note that some systemd versions on Fedora can ignore group-based udev rules, making this setup fragile. ydotool is available in Fedora's repos. It works but adds a system-level daemon dependency. ([ydotool](https://github.com/ReimuNotMoe/ydotool), [Fedora packages](https://packages.fedoraproject.org/pkgs/ydotool/ydotool/))

### Strategy Recommendation (factual)

For Sway in 2026: Strategy A (clipboard + Ctrl+V) is more universally compatible across all apps. Strategy B (wtype / enigo virtual-keyboard) is viable for most apps but can fail in sandboxed Flatpak apps that block virtual-keyboard input.

**Bracketed paste via wtype**: `foot` supports bracketed paste mode (sends `\e[?2004h`). Injecting the escape sequence `\e[200~<text>\e[201~` via wtype using raw key codes is theoretically possible but complex — wtype works at the keysym/keycode level, not raw byte injection. In practice, pasting via clipboard (Ctrl+Shift+V in foot) is simpler and more robust than trying to synthesize bracketed paste escape sequences through virtual-keyboard injection.

---

## 2. Detecting the Focused Window's Class on Sway

Sway's JSON IPC is the idiomatic method. `swaymsg -t get_tree` returns the full window tree; `swaymsg -t get_focused` (or filtering the tree for `focused: true`) gives the active window. The Rust crate `swayipc` (or `i3ipc`) wraps this cleanly.

Key fields:
- **Native Wayland apps**: `app_id` is set (e.g., `"foot"`, `"firefox"`, `"com.vscodium.codium"`). `class` is null.
- **XWayland apps**: `app_id` is null or empty. `class` comes from `WM_CLASS` (e.g., `"Google-chrome"`, `"jetbrains-idea"`).

This distinction is reliable and documented in the Sway man page. Latency is negligible for a single IPC call (sub-millisecond on local socket). The socket path is in `$SWAYSOCK`. ([sway-ipc man page](https://man.archlinux.org/man/sway-ipc.7.en))

No known gotcha for this specific use case, though `app_id` values are set by the application itself and can be inconsistent across Electron apps.

---

## 3. Global Hotkey on Sway

The `global-hotkey` crate is X11-only on Linux and does not work on Wayland.

**Option (b) — xdg-desktop-portal GlobalShortcuts**: Not available on Sway. `xdg-desktop-portal-wlr` has an open issue for this since September 2022 with no implementation. The maintainer explicitly stated it "is not possible with current sway/wlroots." Hyprland's portal backend (`xdg-desktop-portal-hyprland`) added GlobalShortcuts, but that is compositor-specific and not applicable here. ([xdg-desktop-portal-wlr issue #240](https://github.com/emersion/xdg-desktop-portal-wlr/issues/240))

**Option (a) — Sway config `bindsym` + IPC**: This is the idiomatic Sway approach. The user adds a line to `~/.config/sway/config`:

```
bindsym $mod+shift+d exec swaymsg -s $SWAYSOCK 'exec i_transcript_toggle'
```

Or more cleanly, the app listens on its own Unix socket, and the sway binding calls a small helper:

```
bindsym $mod+shift+d exec /usr/local/bin/i_transcript_signal
```

The helper writes to the app's named socket or sends a D-Bus signal. D-Bus is the cleanest IPC pattern: the app registers a well-known name (e.g., `io.example.ITranscript`) and exports a method `Toggle`. The keybinding calls `dbus-send --session --dest=io.example.ITranscript /io/example/ITranscript io.example.ITranscript.Toggle`. This is session-scoped, no root needed, and standard.

**Option (c) — evdev direct**: Requires the user to be in the `input` group. Works but is invasive and not standard practice for desktop apps.

**Most idiomatic for Sway 2026**: Option (a) with D-Bus. It requires one line in the user's sway config, which is expected and normal for Sway power users.

---

## 4. Always-on-Top Non-Focusable HUD Overlay on Sway

**Tauri 2 window type**: Tauri 2 uses `winit` (via `tao`) for windowing, which creates standard `xdg_toplevel` surfaces. `winit` does not implement `wlr-layer-shell` ([winit issue #862](https://github.com/rust-windowing/winit/issues/862)). Sway's tiling layout will therefore attempt to tile any Tauri window like any other application window.

**Tauri window properties on Sway**: `always_on_top`, `decorations: false`, `transparent: true`, `skip_taskbar` are set via `xdg_toplevel` hints that Sway may or may not honor consistently. `focus: false` has no direct Wayland `xdg_toplevel` equivalent — there is no standardized "do not focus me" hint in the protocol. Sway will focus newly created windows by default.

**Sway window rules workaround**: This is the correct solution. Sway's `for_window` directive with `floating enable` and `sticky enable` works reliably in 2026:

```
for_window [app_id="i_transcript_hud"] floating enable, sticky enable, border none
no_focus [app_id="i_transcript_hud"]
```

`sticky` keeps the window visible across workspace switches. `no_focus` (available in Sway) prevents Sway from auto-focusing it on creation. The `app_id` must be set in the Tauri app config (`identifier` field maps to the Wayland `app_id`). This is the standard pattern used by status bars, notification daemons, and similar tools. ([Sway ArchWiki](https://wiki.archlinux.org/title/Sway))

**Click-through**: There is no Tauri 2 API to set a zero input region (`wl_surface.set_input_region`). This is a winit/tao limitation. A transparent, non-interactive overlay cannot be made fully click-through from Tauri on Wayland without patching winit or using a native Wayland library (e.g., `smithay-client-toolkit`). For a brief HUD during recording (not persistent), this is a tolerable limitation — the overlay can be kept very small and positioned in a corner to minimize interference.

---

## 5. Tauri 2 Microphone Access via WebKitGTK on Fedora 43

**Stock Fedora webkit2gtk**: The `webkit2gtk6.0` (or `webkit2gtk4.1`) package in Fedora's repos is **not** compiled with `ENABLE_MEDIA_STREAM=ON` or `ENABLE_WEB_RTC=ON`. `getUserMedia` does not work out of the box. This was confirmed by users on Fedora 39 and has not changed in Fedora 43. Getting it working requires a custom WebKitGTK build with those flags plus `gst-plugins-bad` (for `webrtcbin`). Additionally, testing showed that even with a custom build, the Wayland backend caused rendering issues — X11 was needed for WebRTC streams to render correctly as of early 2025. ([Tauri discussion #8426](https://github.com/tauri-apps/tauri/discussions/8426))

A January 2025 report on Arch Linux with Tauri 2.2.5 confirmed that microphone permission prompts do not appear and devices are inaccessible — indicating this is not a Fedora-only issue. ([Tauri issue #12547](https://github.com/tauri-apps/tauri/issues/12547))

**Practical conclusion**: Relying on `getUserMedia` in the Tauri WebView for microphone capture on Fedora 43 / Wayland is not viable without significant distribution-level workarounds.

**Rust-side fallback via cpal + PipeWire**: `cpal` has a PipeWire backend that requires `pipewire-devel` at build time (available in Fedora). The backend is established and functional; `cpal` with PipeWire is the standard approach for Rust audio apps on Fedora in 2026. The broader PipeWire Rust ecosystem is actively maintained, with a native Rust re-implementation of `libpipewire` underway at Collabora (as of July 2025). Capturing microphone input in the Rust backend via `cpal` and sending audio data to the frontend (or processing it entirely in Rust) is the recommended and reliable path. ([cpal](https://github.com/RustAudio/cpal), [PipeWire Rust workshop 2025](https://www.collabora.com/news-and-blog/blog/2025/07/03/pipewire-workshop-2025-updates-video-transport-rust-bluetooth/))
