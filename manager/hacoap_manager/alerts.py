"""Alerts: a device that stopped answering, a low battery, a plant that needs water, a failed
update, a board that crashed (or was restarted by its watchdog), the border router down (or its
radio unplugged, or off the Thread network), every board silent at once, a board whose link
stays weak for hours, one that keeps changing routers, one that answers but stopped sampling, and a router
boards went through that went away (unplugged, or its PC asleep). They're raised when
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

WEAK_HOURS = 3        # a board's link weak in every network reading of the last this many hours: an alert...
WEAK_READINGS = 3     # ...from this many readings
SWITCHES = 3          # a board that changed routers this many times in the last day: an alert
SWITCH_HOURS = 24
NOT_SAMPLING_S = 2 * 3600  # a board that answers but took no sample for this long: an alert


def _nth(n):
    return f"{n}{'th' if 10 <= n % 100 <= 20 else {1: 'st', 2: 'nd', 3: 'rd'}.get(n % 10, 'th')}"


def weak_link(samples):
    """Whether every one of these link samples (WEAK_READINGS or more) is weak: a link margin
    under fleet.WEAK_MARGIN_DB, else (none measured) a link quality of 1 or less. Samples with
    neither don't tell: not weak."""
    if len(samples) < WEAK_READINGS:
        return False
    for sample in samples:
        margin, quality = sample.get("link_margin"), sample.get("link_quality")
        if margin is not None:
            if margin >= fleet.WEAK_MARGIN_DB:
                return False
        elif quality is None or quality > 1:
            return False
    return True


class AlertService:
    def __init__(self, db, inventory, settings, events):
        self.db = db
        self.inventory = inventory
        self.settings = settings
        self.events = events
        self.border_router = {}  # its problems now ({key: message}), as check_border_router() last found
        self.problems = {}       # other problems the app found: {key: (kind, message)} (a backup copy that failed)
        self._seen_once = {}     # problems found once: an alert only if they're still there next time
        self.network = None      # the NetworkService: its routers that went away

    def set_problem(self, key, problem):
        """A problem found elsewhere: (kind, message), or None once it's gone."""
        if problem is None:
            changed = self.problems.pop(key, None) is not None
        else:
            changed = self.problems.get(key) != problem
            self.problems[key] = problem
        if changed:
            self.scan()

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
        for key, (kind, message) in self.problems.items():
            found[key] = (kind, "", message)
        # Every board silent together: the network, not the boards (a single board's is its own alert)
        known = [d for d in devices if d["address"] and d["last_seen"] is not None]
        if self.inventory.refreshed and len(known) >= 2 and not any(d["online"] for d in known):
            found["network:silent"] = ("network", "", f"None of the {len(known)} boards answer: the border router "
                                                      f"or the Thread network is probably down")
        for node_id, router in (self.network.routers_gone() if self.network else {}).items():
            names = router["names"]
            who = names[0] if len(names) == 1 else f"{', '.join(names[:-1])} and {names[-1]}"
            often = f" It's the {_nth(router['times_this_week'])} time this week." if router.get("times_this_week", 0) > 1 else ""
            found[f"router-gone:{node_id}"] = ("network", "", f"{router['label'].capitalize()} went away: {who} went "
                                                              f"through it. Is it unplugged, or is its computer asleep?{often}")
        now = time.time()
        switches = {}
        for event in self.db.network_events_between(now - SWITCH_HOURS * 3600, now + 1):
            if "parent changed" in event["message"]:
                switches[event["device_id"]] = switches.get(event["device_id"], 0) + 1
        for device in devices:
            device_id = device["device_id"]
            if weak_link(self.db.link_samples(device_id, now - WEAK_HOURS * 3600)):
                found[f"weak-link:{device_id}"] = ("network", device_id,
                                                   f"{NAME}'s link to its router has been weak for {WEAK_HOURS} hours: "
                                                   f"move it closer to a router, or add a router between them")
            last_sample = device.get("last_sample")
            if device["online"] and last_sample and now - last_sample > NOT_SAMPLING_S:
                # Its readings are its last sample's, over and over (the Boot probe firmware of Nov 2026
                # left boards sampling every 5.6 hours)
                found[f"sampling:{device_id}"] = ("sampling", device_id,
                                                  f"{NAME} answers but hasn't taken a sample for over "
                                                  f"{NOT_SAMPLING_S // 3600} hours: its readings don't change. Is its "
                                                  f"sampling period too long (its page, Settings on the board)?")
            if switches.get(device_id, 0) >= SWITCHES:
                found[f"switching:{device_id}"] = ("network", device_id,
                                                   f"{NAME} changed routers {switches[device_id]} times in a day: it's "
                                                   f"probably on the edge between two (it costs battery)")
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

    def _dismiss_one(self, alert_id, open_alerts):
        """Clears it, and notes who did (in its board's activity, its name left out)."""
        alert = next((a for a in open_alerts if a["id"] == alert_id), None)
        if alert is None or not self.db.clear_alert(alert_id, dismissed=True):
            return False
        what = alert["message"].replace(f"{NAME}'s ", "its ").replace(f"{NAME} ", "").replace(NAME, "it")
        self.db.add_activity(alert["device_id"], "dismiss", f"Alert dismissed: {what}")
        return True

    def dismiss(self, alert_id):
        """Clears an open alert. One about a state (a dry plant, say) isn't raised again while it lasts."""
        done = self._dismiss_one(alert_id, self.db.open_alerts())
        if done:
            self.events.publish("alerts")
        return done

    def dismiss_many(self, alert_ids):
        open_alerts = self.db.open_alerts()
        count = sum(self._dismiss_one(alert_id, open_alerts) for alert_id in alert_ids)
        if count:
            self.events.publish("alerts")
        return count

    def state(self):
        return {"open": [self._named(a) for a in self.db.open_alerts()],
                "recent": [self._named(a) for a in self.db.recent_alerts(30)]}
