/*
 * Name: SpeedMeter: Internet Speed Meter
 * Description: A simple and minimal internet speed meter extension for Gnome Shell.
 * Author: Ali Hamidi
 * GitHub: https://github.com/AliHzSec
 * License: GPLv3.0
 */

import Clutter from "gi://Clutter";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import GObject from "gi://GObject";
import Shell from "gi://Shell";
import St from "gi://St";

import {
    Extension
} from "resource:///org/gnome/shell/extensions/extension.js";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as PanelMenu from "resource:///org/gnome/shell/ui/panelMenu.js";

// Update interval, in seconds. The speed shown is the traffic delta over
// exactly this window, so 0.3 second gives a clean per-second reading.
const REFRESH_INTERVAL_SECONDS = 0.3;

// Binary units for speed formatting
const UNIT_KB = 1024;
const UNIT_MB = 1024 * 1024;
const UNIT_GB = 1024 * 1024 * 1024;

// Arrow colors (download = green, upload = blue)
const DOWNLOAD_COLOR = '#2ec27e';
const UPLOAD_COLOR = '#4a90d9';

// Virtual network interfaces to ignore in speed calculation
const VIRTUAL_INTERFACE_PATTERN = /^(lo|br|tun|tap|vnet|virbr|docker|veth|wg|vmbr|vbox|vmnet)\d*(-[\w-]+)?$/;

// Bundled font: family name and the directory (relative to the extension)
// that contains the .ttf files.
const BUNDLED_FONT_FAMILY = 'Victor Mono';
const BUNDLED_FONT_SUBDIR = 'fonts/VictorMono';

/**
 * Format a byte-per-second value into a human friendly string, automatically
 * choosing KB/s, MB/s or GB/s so low speeds are not shown as '0.00 MB/s'.
 * @param {number} bytesPerSec - Speed in bytes per second
 * @returns {string} e.g. '24.6 KB/s', '1.20 MB/s', '2.34 GB/s'
 */
function formatSpeed(bytesPerSec) {
    const value = Math.max(0, bytesPerSec);
    if (value >= UNIT_GB)
        return `${(value / UNIT_GB).toFixed(2)} GB/s`;
    if (value >= UNIT_MB)
        return `${(value / UNIT_MB).toFixed(2)} MB/s`;
    return `${(value / UNIT_KB).toFixed(1)} KB/s`;
}

/**
 * Get only the system interface font size as a CSS style string.
 * The speed label uses Victor Mono (from CSS) but should match the system
 * font size so it blends in with the rest of the panel.
 * @returns {string} e.g. 'font-size: 11pt;' or empty string
 */
function getSystemFontSizeStyle() {
    try {
        const settings = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
        const fontName = settings.get_string('font-name'); // e.g. 'Cantarell 11'
        const match = fontName.match(/^(.*?)[\s,]+(\d+(?:\.\d+)?)$/);
        if (match)
            return `font-size: ${match[2]}pt;`;
    } catch (e) {
        console.error('SpeedMeter: Error reading system font:', e);
    }
    return '';
}

/**
 * Copy the bundled fonts into the user font directory (idempotently) and
 * refresh the font cache so Pango can resolve them. If Victor Mono is still
 * unavailable, the CSS font stack falls back to the system monospace font.
 * @param {string} extensionPath - Path to the extension directory
 */
function installBundledFonts(extensionPath) {
    try {
        const srcDir = Gio.File.new_for_path(
            GLib.build_filenamev([extensionPath, ...BUNDLED_FONT_SUBDIR.split('/')]));
        if (!srcDir.query_exists(null))
            return;

        const destDirPath = GLib.build_filenamev(
            [GLib.get_home_dir(), '.local', 'share', 'fonts']);
        const destDir = Gio.File.new_for_path(destDirPath);
        try {
            destDir.make_directory_with_parents(null);
        } catch (e) {
            // Directory already exists: ignore
        }

        let copiedAny = false;
        const enumerator = srcDir.enumerate_children(
            'standard::name', Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = enumerator.next_file(null)) !== null) {
            const name = info.get_name();
            if (!name.toLowerCase().endsWith('.ttf'))
                continue;
            const dest = destDir.get_child(name);
            if (dest.query_exists(null))
                continue;
            srcDir.get_child(name).copy(dest, Gio.FileCopyFlags.NONE, null, null);
            copiedAny = true;
        }
        enumerator.close(null);

        if (copiedAny) {
            const fcCache = GLib.find_program_in_path('fc-cache');
            if (fcCache) {
                const proc = Gio.Subprocess.new(
                    [fcCache, '-f', destDirPath],
                    Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
                proc.wait_async(null, null);
            }
        }
    } catch (e) {
        console.error('SpeedMeter: Error installing bundled fonts:', e);
    }
}

/**
 * SpeedMeterButton - Main panel button widget for the extension
 * Displays network speed only
 */
const SpeedMeterButton = GObject.registerClass(
    class SpeedMeterButton extends PanelMenu.Button {
        _init(extension) {
            // Pass true to skip creating a menu: there is none, and skipping it
            // means clicking the widget does nothing (no empty popup toggles).
            super._init(0.5, 'SpeedMeter', true);

            // Scopes the hover/focus/active override in stylesheet.css to just
            // this button, so GNOME Shell's default panel-button highlight does
            // not draw a second border on top of our pill on hover.
            this.add_style_class_name('speedmeter-button');

            this._extension = extension;
            this._refreshLoop = null;
            this._prevUploadBytes = 0;
            this._prevDownloadBytes = 0;

            // Make the bundled monospace font available (idempotent).
            installBundledFonts(this._extension.path);

            // Create panel box layout: a rounded pill with a white border,
            // matching the IP-Finder look. The default GNOME hover highlight is
            // suppressed via the 'speedmeter-button' class above.
            const panelBox = new St.BoxLayout({
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'panel-status-menu-box panel-button-box speedmeter-panel-box',
                style: 'spacing: 6px;'
            });
            this.add_child(panelBox);

            // Create speed label for panel (Victor Mono via CSS, system size).
            // Colored arrows are rendered with Pango markup, so no initial text.
            this._speedLabel = new St.Label({
                style_class: 'speedmeter-speed-label',
                style: getSystemFontSizeStyle(),
                y_align: Clutter.ActorAlign.CENTER
            });
            panelBox.add_child(this._speedLabel);

            // Show a zeroed reading until the first sample arrives.
            this._renderSpeeds(0, 0);

            // Start speed monitoring
            this._startSpeedUpdate();
        }

        /**
         * Render the download/upload speeds into the label with colored arrows.
         * @param {number} downBytesPerSec - Download speed in bytes/second
         * @param {number} upBytesPerSec - Upload speed in bytes/second
         */
        _renderSpeeds(downBytesPerSec, upBytesPerSec) {
            const down = formatSpeed(downBytesPerSec);
            const up = formatSpeed(upBytesPerSec);
            const markup =
                `<span foreground="${DOWNLOAD_COLOR}">\u2193</span> ${down}` +
                `  \u25cf  ` +
                `<span foreground="${UPLOAD_COLOR}">\u2191</span> ${up}`;
            this._speedLabel.clutter_text.set_markup(markup);
        }

        /**
         * Starts the speed update loop
         */
        _startSpeedUpdate() {
            // Initialize baseline values
            this._updateSpeed(true);

            // Start periodic updates
            this._refreshLoop = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT,
                REFRESH_INTERVAL_SECONDS * 1000,
                () => {
                    this._updateSpeed(false);
                    return GLib.SOURCE_CONTINUE;
                }
            );
        }

        /**
         * Updates network speed display
         * @param {boolean} initialize - If true, only reads baseline values without updating display
         */
        _updateSpeed(initialize = false) {
            try {
                const lines = Shell.get_file_contents_utf8_sync('/proc/net/dev').split('\n');
                let uploadBytes = 0;
                let downloadBytes = 0;

                // Sum bytes from all relevant network interfaces
                for (const line of lines) {
                    const trimmedLine = line.trim();
                    const columns = trimmedLine.split(/\s+/);

                    if (columns.length <= 2) continue;

                    const iface = columns[0].replace(':', '');

                    // Skip virtual and loopback interfaces
                    if (VIRTUAL_INTERFACE_PATTERN.test(iface)) {
                        continue;
                    }

                    const rxBytes = parseInt(columns[1]);
                    const txBytes = parseInt(columns[9]);

                    if (!isNaN(rxBytes) && !isNaN(txBytes)) {
                        downloadBytes += rxBytes;
                        uploadBytes += txBytes;
                    }
                }

                if (initialize) {
                    // Store baseline values
                    this._prevDownloadBytes = downloadBytes;
                    this._prevUploadBytes = uploadBytes;
                    return;
                }

                // Calculate speed in bytes per second
                const downloadSpeed = (downloadBytes - this._prevDownloadBytes) / REFRESH_INTERVAL_SECONDS;
                const uploadSpeed = (uploadBytes - this._prevUploadBytes) / REFRESH_INTERVAL_SECONDS;

                // Update baseline values for next iteration
                this._prevDownloadBytes = downloadBytes;
                this._prevUploadBytes = uploadBytes;

                // Update display (auto units + colored arrows)
                this._renderSpeeds(downloadSpeed, uploadSpeed);

            } catch (e) {
                console.error('SpeedMeter: Error updating speed:', e);
                const markup =
                    `<span foreground="${DOWNLOAD_COLOR}">\u2193</span> --` +
                    `  \u25cf  ` +
                    `<span foreground="${UPLOAD_COLOR}">\u2191</span> --`;
                this._speedLabel.clutter_text.set_markup(markup);
            }
        }

        /**
         * Cleanup when extension is disabled
         */
        disable() {
            // Remove speed update timer
            if (this._refreshLoop) {
                GLib.source_remove(this._refreshLoop);
                this._refreshLoop = null;
            }

            // Reset state
            this._prevDownloadBytes = 0;
            this._prevUploadBytes = 0;
        }
    });

/**
 * SpeedMeterExtension - Main extension class
 */
export default class SpeedMeterExtension extends Extension {
    enable() {
        this._indicator = new SpeedMeterButton(this);
        Main.panel.addToStatusArea('speed-meter', this._indicator, 0, 'right');
    }

    disable() {
        if (this._indicator) {
            this._indicator.disable();
            this._indicator.destroy();
            this._indicator = null;
        }
    }
}