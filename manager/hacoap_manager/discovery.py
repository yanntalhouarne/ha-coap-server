"""Finds ha-coap devices on the network: the border router publishes their SRP
registrations (service _ot._udp, instances ha-coap-<device ID>) over mDNS/DNS-SD, with the
TXT records newer firmware registers: id, fw (git commit), hw (board revision), ver (image)."""

import asyncio
import ipaddress
from dataclasses import dataclass

SERVICE_TYPE = "_ot._udp.local."
NAME_PREFIX = "ha-coap"


@dataclass
class Found:
    instance: str   # ha-coap-1a2b3c4d
    device_id: str  # 1a2b3c4d, or "" without a suffix
    address: str    # the device's IPv6 address
    txt: dict = None  # its TXT records, as text: {"fw": "f83f898", "hw": "v2.0", ...}


def txt_records(properties):
    """The TXT records as text (zeroconf gives bytes, and None for a flag without a value)."""
    return {key.decode(errors="replace"): (value or b"").decode(errors="replace")
            for key, value in (properties or {}).items() if isinstance(key, bytes)}


def device_id_from_instance(instance):
    """'ha-coap-1a2b3c4d' -> '1a2b3c4d'. The integration uses the same rule."""
    prefix = NAME_PREFIX + "-"
    return instance[len(prefix):] if instance.startswith(prefix) else ""


def is_usable_ipv6(address):
    """A global or unique-local IPv6 address (not link-local or loopback)."""
    address = address.split("%")[0].lower()
    return ":" in address and not address.startswith("fe80") and address != "::1"


SIMULATOR_FLAG = b"sim"  # TXT entry set only by the simulated device (simdevice.py)


def is_loopback(address):
    try:
        return ipaddress.ip_address(address).is_loopback
    except ValueError:
        return False


def pick_address(addresses, properties=None):
    """The address to reach a device at: its global or unique-local IPv6 address. A loopback
    address only for the simulated device, which says so in its TXT record (the simulated
    fleet uses 127.0.0.1, 127.0.0.2 and so on)."""
    usable = [a for a in addresses if is_usable_ipv6(a)]
    if usable:
        return usable[0]
    if (properties or {}).get(SIMULATOR_FLAG) == b"1":
        return next((a for a in addresses if is_loopback(a)), None)
    return None


async def discover(timeout=4.0):
    """Browses for devices for 'timeout' seconds. Returns a list of Found."""
    from zeroconf import IPVersion, ServiceStateChange
    from zeroconf.asyncio import AsyncServiceBrowser, AsyncServiceInfo, AsyncZeroconf

    names = set()

    def on_change(zeroconf, service_type, name, state_change):
        if state_change in (ServiceStateChange.Added, ServiceStateChange.Updated):
            names.add(name)

    aiozc = AsyncZeroconf()
    try:
        browser = AsyncServiceBrowser(aiozc.zeroconf, SERVICE_TYPE, handlers=[on_change])
        await asyncio.sleep(timeout)
        await browser.async_cancel()

        found = []
        for name in sorted(names):
            instance = name[: -len("." + SERVICE_TYPE)] if name.endswith("." + SERVICE_TYPE) else name
            if not instance.startswith(NAME_PREFIX):
                continue
            info = AsyncServiceInfo(SERVICE_TYPE, name)
            if not await info.async_request(aiozc.zeroconf, 3000):
                continue
            address = pick_address(info.parsed_addresses(IPVersion.All), info.properties)
            if address:
                txt = txt_records(info.properties)
                found.append(Found(instance, txt.get("id") or device_id_from_instance(instance), address, txt))
        return found
    finally:
        await aiozc.async_close()


def discovery_available():
    try:
        import zeroconf  # noqa: F401
        return True
    except ImportError:
        return False
