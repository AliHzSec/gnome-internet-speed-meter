/*
 * Name: SpeedMeter: Internet Speed Meter
 * Description: A simple and minimal internet speed meter extension for Gnome Shell.
 * Author: Ali Hamidi
 * GitHub: https://github.com/AliHzSec
 * License: GPLv3.0
 */

import Clutter from "gi://Clutter";
import GLib from "gi://GLib";
import GObject from "gi://GObject";
import Shell from "gi://Shell";
import St from "gi://St";

import {
    Extension
} from "resource:///org/gnome/shell/extensions/extension.js";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as PanelMenu from "resource:///org/gnome/shell/ui/panelMenu.js";

// Constants for speed calculation
const REFRESH_INTERVAL_SECONDS = 0.2;
const UNIT_BASE = 1024.0;
const BYTES_TO_MEGABYTES = UNIT_BASE * UNIT_BASE;

// Virtual network interfaces to ignore in speed calculation
const VIRTUAL_INTERFACE_PATTERN = /^(lo|br|tun|tap|vnet|virbr|docker|veth|wg|vmbr|vbox|vmnet)\d*(-[\w-]+)?$/;

/**
 * SpeedMeterButton - Main panel button widget for the extension
 * Displays network speed only
 */
const SpeedMeterButton = GObject.registerClass(
    class SpeedMeterButton extends PanelMenu.Button {
        _init(extension) {
            super._init(0.5, 'SpeedMeter', false); // false = no menu

            this._extension = extension;
            this._refreshLoop = null;
            this._prevUploadBytes = 0;
            this._prevDownloadBytes = 0;

            // Create speed label for panel
            this._speedLabel = new St.Label({
                text: '↓ 0.00 MB/s  ↑ 0.00 MB/s',
                style_class: 'speedmeter-speed-label',
                y_align: Clutter.ActorAlign.CENTER
            });
            this.add_child(this._speedLabel);

            // Start speed monitoring
            this._startSpeedUpdate();
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

                // Convert to MB/s and update display
                const downMBps = downloadSpeed / BYTES_TO_MEGABYTES;
                const upMBps = uploadSpeed / BYTES_TO_MEGABYTES;

                this._speedLabel.set_text(
                    `↓ ${downMBps.toFixed(2)} MB/s  ↑ ${upMBps.toFixed(2)} MB/s`
                );

            } catch (e) {
                console.error('SpeedMeter: Error updating speed:', e);
                this._speedLabel.set_text('↓ -.-- MB/s  ↑ -.-- MB/s');
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