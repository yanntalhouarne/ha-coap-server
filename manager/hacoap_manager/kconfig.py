"""The firmware's build-time settings, read from application/Kconfig (the "ha-coap
application" menu) plus a few SDK options, and turned into a .conf file for a build.

Only the application's own options are offered, as a form: the rest of the configuration
stays in prj.conf, the variant's overlays and local.conf (the PSKd).
"""

import re

# SDK options worth changing per build. Their defaults come from prj.conf.
EXTRA_SYMBOLS = [
    {
        "name": "OPENTHREAD_POLL_PERIOD",
        "type": "int",
        "prompt": "Thread poll period (ms)",
        "help": "How often the sleepy device asks its parent for messages: commands can take this long "
                "to arrive. Shorter is more responsive and uses more battery (about 9 uA at 3000 ms, "
                "21 uA at 1000 ms).",
        "range": [100, 60000],
        "menu": "Thread",
    },
]

STRING_MAX = 64
KEYWORDS = ("config", "menuconfig", "menu", "endmenu", "choice", "endchoice", "if", "endif",
            "source", "module", "module-str", "comment", "mainmenu")


class KconfigError(ValueError):
    pass


def _unquote(text):
    text = text.strip()
    if len(text) >= 2 and text[0] == '"' and text[-1] == '"':
        return text[1:-1].replace('\\"', '"').replace("\\\\", "\\")
    return text


def _default_value(kind, text):
    if kind == "int":
        return int(text, 0)
    if kind == "bool":
        return text == "y"
    return _unquote(text)


def parse_kconfig(text, menu_title="ha-coap application"):
    """The symbols of one menu (and its submenus) of a Kconfig file, in order."""
    symbols = []
    menus = []         # the stack of open menu titles
    inside = False     # within menu_title
    symbol = None
    choice = None
    help_indent = None
    for line in text.splitlines():
        stripped = line.strip()
        word = stripped.split(maxsplit=1)[0] if stripped else ""
        if help_indent is not None:
            indent = len(line) - len(line.lstrip())
            if not stripped or indent >= help_indent and word not in KEYWORDS:
                if stripped:
                    target = choice if choice is not None and symbol is None else symbol
                    if target is not None:
                        target["help"] = (target["help"] + " " + stripped).strip()
                continue
            help_indent = None
        if word == "menu":
            title = _unquote(stripped[4:])
            menus.append(title)
            if title == menu_title:
                inside = True
            symbol = None
            continue
        if word == "endmenu":
            title = menus.pop() if menus else ""
            if title == menu_title:
                inside = False
            symbol = None
            continue
        if not inside:
            continue
        group = menus[-1] if menus and menus[-1] != menu_title else "General"
        if word in ("config", "menuconfig"):
            symbol = {"name": stripped.split()[1], "type": None, "prompt": "", "help": "", "default": None,
                      "range": None, "menu": group, "depends_on": None}
            if choice is not None:
                choice["options"].append(symbol)
            else:
                symbols.append(symbol)
        elif word == "choice":
            choice = {"name": stripped.split()[1] if len(stripped.split()) > 1 else "", "type": "choice",
                      "prompt": "", "help": "", "default": None, "options": [], "menu": group, "depends_on": None}
            symbols.append(choice)
            symbol = None
        elif word == "endchoice":
            for option in choice["options"]:
                option.pop("default", None)
            choice["options"] = [{"name": o["name"], "prompt": o["prompt"]} for o in choice["options"]]
            choice = None
            symbol = None
        elif word in ("bool", "int", "string", "hex") and (symbol is not None or choice is not None):
            target = symbol if symbol is not None else choice
            if symbol is not None:
                symbol["type"] = word
            rest = stripped[len(word):].strip()
            if rest:
                target["prompt"] = _unquote(rest)
        elif word == "prompt":
            target = symbol if symbol is not None else choice
            if target is not None:
                target["prompt"] = _unquote(stripped[6:])
        elif word == "default":
            value = stripped[7:].strip()
            if symbol is not None and choice is None and symbol["default"] is None:
                symbol["default"] = _default_value(symbol["type"], value)
            elif choice is not None and symbol is None and choice["default"] is None:
                choice["default"] = value
        elif word == "range" and symbol is not None:
            low, high = stripped.split()[1:3]
            symbol["range"] = [int(low, 0), int(high, 0)]
        elif word == "depends" and symbol is not None:
            symbol["depends_on"] = stripped.split(None, 2)[2]
        elif word == "help":
            help_indent = len(line) - len(line.lstrip()) + 1
    return [s for s in symbols if s["type"] is not None]


def conf_values(text):
    """{NAME: value} of the CONFIG_ lines in a .conf file (without the CONFIG_ prefix)."""
    values = {}
    for line in text.splitlines():
        match = re.match(r"\s*CONFIG_(\w+)\s*=\s*(.*?)\s*$", line)
        if match:
            values[match.group(1)] = match.group(2)
    return values


def load_schema(repository):
    """The settings a build profile can change, with their defaults (Kconfig, then prj.conf)."""
    application = repository / "application"
    symbols = parse_kconfig((application / "Kconfig").read_text(encoding="utf-8"))
    prj = conf_values((application / "prj.conf").read_text(encoding="utf-8"))
    for extra in EXTRA_SYMBOLS:
        if extra["name"] in prj:
            symbols.append({**extra, "default": _default_value(extra["type"], prj[extra["name"]]),
                            "depends_on": None})
    for symbol in symbols:
        if symbol["name"] in prj and symbol["type"] != "choice":
            symbol["default"] = _default_value(symbol["type"], prj[symbol["name"]])
    return symbols


def validate(schema, settings):
    """Checks a profile's settings ({NAME: value}) against the schema. Returns them cleaned."""
    by_name = {s["name"]: s for s in schema}
    clean = {}
    for name, value in settings.items():
        symbol = by_name.get(name)
        if symbol is None:
            raise KconfigError(f"Unknown setting {name}")
        kind = symbol["type"]
        if kind == "int":
            try:
                value = int(value)
            except (TypeError, ValueError):
                raise KconfigError(f"{symbol['prompt']}: a whole number is needed") from None
            if symbol["range"] and not symbol["range"][0] <= value <= symbol["range"][1]:
                raise KconfigError(f"{symbol['prompt']}: must be from {symbol['range'][0]} to {symbol['range'][1]}")
        elif kind == "bool":
            if not isinstance(value, bool):
                raise KconfigError(f"{symbol['prompt']}: true or false")
        elif kind == "string":
            value = str(value)
            if len(value) > STRING_MAX or any(c in value for c in '"\\\n\r') or not value.isprintable():
                raise KconfigError(f"{symbol['prompt']}: up to {STRING_MAX} printable characters, without quotes or backslashes")
        elif kind == "choice":
            if value not in [o["name"] for o in symbol["options"]]:
                raise KconfigError(f"{symbol['prompt']}: unknown option {value}")
        else:
            raise KconfigError(f"{name}: settings of type {kind} can't be changed here")
        clean[name] = value
    if clean.get("HACOAP_SOIL_DRY_MV", _default(by_name, "HACOAP_SOIL_DRY_MV")) <= \
            clean.get("HACOAP_SOIL_WET_MV", _default(by_name, "HACOAP_SOIL_WET_MV")):
        raise KconfigError("The dry soil voltage must be above the wet one")
    if clean.get("HACOAP_WDT_FEED_PERIOD_MS", _default(by_name, "HACOAP_WDT_FEED_PERIOD_MS")) >= \
            clean.get("HACOAP_WDT_TIMEOUT_MS", _default(by_name, "HACOAP_WDT_TIMEOUT_MS")):
        raise KconfigError("The watchdog feed period must be shorter than its timeout")
    if "OPENTHREAD_POLL_PERIOD" in by_name and \
            clean.get("HACOAP_MCUMGR_POLL_PERIOD_MS", _default(by_name, "HACOAP_MCUMGR_POLL_PERIOD_MS")) >= \
            clean.get("OPENTHREAD_POLL_PERIOD", _default(by_name, "OPENTHREAD_POLL_PERIOD")):
        raise KconfigError("The poll period while mcumgr is in use must be shorter than the Thread poll period")
    return clean


def _default(by_name, name):
    symbol = by_name.get(name)
    return symbol["default"] if symbol is not None and symbol["default"] is not None else 0


def to_conf(schema, settings, title=""):
    """A .conf file with a profile's settings."""
    by_name = {s["name"]: s for s in schema}
    lines = [f"# Fleet manager build profile{': ' + title if title else ''}"]
    for name, value in settings.items():
        kind = by_name[name]["type"]
        if kind == "int":
            lines.append(f"CONFIG_{name}={value}")
        elif kind == "bool":
            lines.append(f"CONFIG_{name}={'y' if value else 'n'}")
        elif kind == "string":
            lines.append(f'CONFIG_{name}="{value}"')
        elif kind == "choice":
            lines.append(f"CONFIG_{value}=y")
    return "\n".join(lines) + "\n"
