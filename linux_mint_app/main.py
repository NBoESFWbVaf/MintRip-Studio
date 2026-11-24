#!/usr/bin/env python3
"""Startpunkt für MintRip Studio unter Linux Mint (GTK 3.0 + PyCdio)."""

from __future__ import annotations

import sys

import gi

gi.require_version("Gtk", "3.0")
from gi.repository import Gtk

from mintrip.theme import bootstrap_system_theme_env
from mintrip.ui_window import MintRipWindow


class MintRipApplication(Gtk.Application):
    def __init__(self) -> None:
        super().__init__(application_id="org.linuxmint.MintRip")

    def do_activate(self) -> None:
        window = self.props.active_window
        if not window:
            window = MintRipWindow(self)
        window.show_all()
        window.present()


def main() -> int:
    bootstrap_system_theme_env()
    app = MintRipApplication()
    return app.run(sys.argv)


if __name__ == "__main__":
    raise SystemExit(main())
