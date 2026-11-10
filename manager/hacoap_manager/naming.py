"""What a device is called on the page, in alerts, the activity feed and the summary.

The name given to it (its plant field, set from the simple view or its page, such as
"ha-coap-9" or "basil") comes first; else the board's own name (ha-coap-<ID>), else its ID.
The board's own name goes next to it where there's room (board_name), so both can be found.
"""


def display_name(device):
    """The name given to the device, else the board's own name, else its ID."""
    if not device:
        return ""
    return (device.get("plant") or "").strip() or device.get("name") or device.get("device_id") or ""


def board_name(device):
    """The board's own name (ha-coap-<ID>, or its ID)."""
    if not device:
        return ""
    return device.get("name") or device.get("device_id") or ""


def names(device):
    """{"name": what it's called, "board": the board's own name}, for the page's lists."""
    return {"name": display_name(device), "board": board_name(device)}
