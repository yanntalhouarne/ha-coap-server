"""Finds ha-coap devices on the network: the border router publishes their SRP
registrations (service _ot._udp, instances ha-coap-<device ID>) over mDNS/DNS-SD."""

import asyncio
from dataclasses import dataclass

SERVICE_TYPE = "_ot._udp.local."
NAME_PREFIX = "ha-coap"


@dataclass
class Found:
    instance: str   # ha-coap-1a2b3c4d
    device_id: str  # 1a2b3c4d, or "" without a suffix
    address: str    # the device's IPv6 address


def device_id_from_instance(instance):
    """'ha-coap-1a2b3c4d' -> '1a2b3c4d'. The integration uses the same rule."""
    prefix = NAME_PREFIX + "-"
    return instance[len(prefix):] if instance.startswith(prefix) else ""


def is_usable_ipv6(address):
    """A global or unique-local IPv6 address (not link-local or loopback)."""
    address = address.split("%")[0].lower()
    return ":" in address and not address.startswith("fe80") and address != "::1"


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
            addresses = [a for a in info.parsed_addresses(IPVersion.V6Only) if is_usable_ipv6(a)]
            if addresses:
                found.append(Found(instance, device_id_from_instance(instance), addresses[0]))
        return found
    finally:
        await aiozc.async_close()


def discovery_available():
    try:
        import zeroconf  # noqa: F401
        return True
    except ImportError:
        return False
