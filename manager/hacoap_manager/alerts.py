"""Alerts: a device that stopped answering, a low battery, a plant that needs water, a failed
update. They're raised when the condition starts and cleared when it ends (or dismissed), and
each new one is sent to the page, which can show it as a browser notification.

Messages are stored with a {name} placeholder, filled in with the device's name when read, so
an alert follows a rename."""

from . import fleet

NAME = "{name}"


class AlertService:
    def __init__(self, db, inventory, settings, events):
        self.db = db
        self.inventory = inventory
        self.settings = settings
        self.events = events

    def conditions(self):
        """What's wrong now: {key: (kind, device_id, message)}."""
        found = {}
        for device in self.inventory.devices():
            device_id = device["device_id"]
            # Only once the app has asked every device: at start, the last answers are old.
            if self.inventory.refreshed and not device["online"] and device["last_seen"] is not None:
                found[f"offline:{device_id}"] = ("offline", device_id, f"{NAME} stopped answering")
            if device["battery"] is not None and device["battery"] <= fleet.LOW_BATTERY:
                found[f"battery:{device_id}"] = ("battery", device_id,
                                                 f"{NAME}'s battery is low (under {fleet.LOW_BATTERY + 1} %)")
            if device["needs_water"]:
                found[f"dry:{device_id}"] = ("dry", device_id,
                                             f"{NAME} needs water (soil under {device['water_target']} %)")
        return found

    def _named(self, alert):
        """The alert with its device's current name in the message."""
        if NAME not in alert["message"]:
            return alert
        device = self.db.device(alert["device_id"]) if alert["device_id"] else None
        name = (device and device["name"]) or alert["device_id"] or "A device"
        return {**alert, "message": alert["message"].replace(NAME, name)}

    def scan(self):
        """Raises the new alerts and clears the ones that went away. Returns the new ones."""
        now = self.conditions()
        open_alerts = self.db.open_alerts()
        open_keys = {a["key"] for a in open_alerts}
        new = []
        for key, (kind, device_id, message) in now.items():
            if key not in open_keys:
                new.append(self._named(self.db.add_alert(key, kind, device_id, message)))
        cleared = [a for a in open_alerts if a["kind"] != "update" and a["key"] not in now]
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

    def dismiss(self, alert_id):
        done = self.db.clear_alert(alert_id, dismissed=True)
        if done:
            self.events.publish("alerts")
        return done

    def state(self):
        return {"open": [self._named(a) for a in self.db.open_alerts()],
                "recent": [self._named(a) for a in self.db.recent_alerts(30)]}
