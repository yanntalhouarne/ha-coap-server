"""Alerts: a device that stopped answering, a low battery, a plant that needs water, a failed
update, a board that crashed (or was restarted by its watchdog), the border router down (or its
radio unplugged, or off the Thread network), and every board silent at once. They're raised when
the condition starts and cleared when it ends (or dismissed), and each new one is sent to the
page, which can show it as a browser notification.

Messages are stored with a {name} placeholder, filled in with the device's name when read, so
an alert follows a rename."""

import time

from . import fleet
from .naming import display_name
from .inventory import reset_text

NAME = "{name}"

# Alerts about something that happened, rather than a state: they stay until dismissed.
EVENTS = ("update", "restart")


class AlertService:
    def __init__(self, db, inventory, settings, events):
        self.db = db
        self.inventory = inventory
        self.settings = settings
        self.events = events
        self.border_router = {}  # its problems now ({key: message}), as check_border_router() last found
        self._seen_once = {}     # problems found once: an alert only if they're still there next time

    def check_border_router(self, problems):
        """The border router's problems now (BorderRouterService.health(), every minute). One is an
        alert from the second check in a row that finds it: a restart doesn't raise any."""
        confirmed = {key: message for key, message in problems.items() if key in self._seen_once}
        self._seen_once = dict(problems)
        if confirmed != self.border_router:
            self.border_router = confirmed
            self.scan()

    def conditions(self):
        """What's wrong now: {key: (kind, device_id, message)}."""
        found = {}
        devices = self.inventory.devices()
        for key, message in self.border_router.items():
            found[key] = ("border-router", "", message)
        # Every board silent together: the network, not the boards (a single board's is its own alert)
        known = [d for d in devices if d["address"] and d["last_seen"] is not None]
        if self.inventory.refreshed and len(known) >= 2 and not any(d["online"] for d in known):
            found["network:silent"] = ("network", "", f"None of the {len(known)} boards answer: the border router "
                                                      f"or the Thread network is probably down")
        for device in devices:
            device_id = device["device_id"]
            # Only once the app has asked every device: at start, the last answers are old.
            if self.inventory.refreshed and not device["online"] and device["last_seen"] is not None:
                found[f"offline:{device_id}"] = ("offline", device_id, f"{NAME} stopped answering")
            if device["battery"] is not None and device["battery"] <= fleet.LOW_BATTERY and not fleet.on_usb(device):
                found[f"battery:{device_id}"] = ("battery", device_id,
                                                 f"{NAME}'s battery is low (under {fleet.LOW_BATTERY + 1} %)")
            if device["needs_water"]:
                found[f"dry:{device_id}"] = ("dry", device_id,
                                             f"{NAME} needs water (soil under {device['water_target']} %)")
            tank = device.get("tank")
            if tank and tank["low"]:
                found[f"tank:{device_id}"] = ("tank", device_id, f"{NAME}'s water tank is about {tank['percent']} % full "
                                                                 f"({tank['left_ml']} ml left): refill it")
            if device.get("watering_missed"):
                found[f"missed:{device_id}"] = ("tank", device_id,
                                                f"{NAME}'s soil didn't rise after its last {fleet.NO_RISE_RUNS} waterings: "
                                                f"its tank may be empty, or the tube out of the pot")
        return found

    def _named(self, alert):
        """The alert with its device's current name in the message."""
        if NAME not in alert["message"]:
            return alert
        device = self.db.device(alert["device_id"]) if alert["device_id"] else None
        name = display_name(device) or alert["device_id"] or "A device"
        return {**alert, "message": alert["message"].replace(NAME, name)}

    def scan(self):
        """Raises the new alerts and clears the ones that went away. Returns the new ones."""
        now = self.conditions()
        open_alerts = self.db.open_alerts()
        open_keys = {a["key"] for a in open_alerts}
        quiet = self.db.quiet_alert_keys()  # dismissed: not again while it lasts
        new = []
        for key, (kind, device_id, message) in now.items():
            if key not in open_keys and key not in quiet:
                new.append(self._named(self.db.add_alert(key, kind, device_id, message)))
        for key in quiet - now.keys():
            self.db.end_quiet_alert(key)  # it ended: the next time, it's raised again
        cleared = [a for a in open_alerts if a["kind"] not in EVENTS and a["key"] not in now]
        for alert in cleared:
            self.db.clear_alert(alert["id"])
        for alert in new:
            self.events.publish("alert", alert=alert)
        if new or cleared:
            self.events.publish("alerts")
        return new

    def update_failed(self, job_id, device_id, label, message):
        who = NAME if device_id else label  # a board on USB that isn't in the list has only its port
        alert = self._named(self.db.add_alert(f"update:{job_id}:{device_id or label}", "update", device_id,
                                              f"Update of {who} failed: {message}"))
        self.events.publish("alert", alert=alert)
        self.events.publish("alerts")

    def restarted(self, device, cause, fault):
        """A board restarted for a bad reason: a crash, its watchdog, a CPU lockup."""
        alert = self._named(self.db.add_alert(f"restart:{device['device_id']}:{time.time():.0f}", "restart",
                                              device["device_id"], f"{NAME} restarted: {reset_text(cause, fault)}"))
        self.events.publish("alert", alert=alert)
        self.events.publish("alerts")

    def dismiss(self, alert_id):
        """Clears an open alert. One about a state (a dry plant, say) isn't raised again while it lasts."""
        done = self.db.clear_alert(alert_id, dismissed=True)
        if done:
            self.events.publish("alerts")
        return done

    def dismiss_many(self, alert_ids):
        count = sum(self.db.clear_alert(alert_id, dismissed=True) for alert_id in alert_ids)
        if count:
            self.events.publish("alerts")
        return count

    def state(self):
        return {"open": [self._named(a) for a in self.db.open_alerts()],
                "recent": [self._named(a) for a in self.db.recent_alerts(30)]}
