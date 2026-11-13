import asyncio

import pytest

from hacoap_manager import coap


def test_encode_decode_round_trip():
    data = coap.encode(coap.TYPE_CON, coap.GET, 0x1234, b"\xaa\xbb", "a/very-long-path-segment-over-13/x", b"hi")
    message = coap.decode(data)
    assert (message.type, message.code, message.message_id, message.token) == (coap.TYPE_CON, coap.GET, 0x1234, b"\xaa\xbb")
    assert message.path == "a/very-long-path-segment-over-13/x"
    assert message.payload == b"hi"


def test_decode_rejects_garbage():
    with pytest.raises(coap.CoapError):
        coap.decode(b"\x00\x01")
    with pytest.raises(coap.CoapError):
        coap.decode(b"\x4f\x01\x00\x00")  # token longer than the message


def test_parse_data_reads_a_signed_temperature():
    assert coap.parse_data(bytes([42, 87, 55, 251])) == coap.SensorData(42, 87, 55, -5)
    assert coap.parse_data(bytes([0, 0, 0, 25])).temperature == 25
    with pytest.raises(coap.CoapError):
        coap.parse_data(b"\x01")


def test_parse_info():
    assert coap.parse_info(b"abc1234,v2.0,1a2b3c4d\0") == coap.DeviceInfo("abc1234", "v2.0", "1a2b3c4d")
    with pytest.raises(coap.CoapError):
        coap.parse_info(b"garbage\0")


async def test_info_and_data_from_the_simulator(start_sim):
    server = await start_sim()
    info = await coap.get_info("127.0.0.1", port=server.coap_port)
    assert info.device_id == "1a2b3c4d"
    assert info.hw_version == "v2.0"
    data = await coap.get_data("127.0.0.1", port=server.coap_port)
    assert data.temperature == -5


async def test_retransmits_a_lost_request(start_sim):
    server = await start_sim(drop_coap_first=2)
    info = await coap.get_info("127.0.0.1", port=server.coap_port, ack_timeout=0.1, max_retransmit=3)
    assert info.device_id == "1a2b3c4d"


async def test_times_out_without_an_answer(start_sim):
    server = await start_sim(drop_coap_first=10)
    with pytest.raises(TimeoutError):
        await coap.get_info("127.0.0.1", port=server.coap_port, ack_timeout=0.1, max_retransmit=1)


async def test_ping_beeps(start_sim):
    server = await start_sim()
    await coap.ping("127.0.0.1", port=server.coap_port)
    await coap.ping("127.0.0.1", beep=False, port=server.coap_port)
    assert server.device.pings == 1


class _SeparateResponder(asyncio.DatagramProtocol):
    """Answers with an empty ACK, then the response in a separate confirmable message."""

    def connection_made(self, transport):
        self.transport = transport
        self.acks = 0

    def datagram_received(self, data, addr):
        message = coap.decode(data)
        if message.type == coap.TYPE_ACK:
            self.acks += 1
            return
        self.transport.sendto(coap.encode(coap.TYPE_ACK, 0, message.message_id, b""), addr)
        response = coap.encode(coap.TYPE_CON, coap.CONTENT, 0x7777, message.token, payload=b"abc,v2.0,99\0")
        asyncio.get_running_loop().call_later(0.05, self.transport.sendto, response, addr)


async def test_separate_response_is_acknowledged():
    loop = asyncio.get_running_loop()
    transport, protocol = await loop.create_datagram_endpoint(_SeparateResponder, local_addr=("127.0.0.1", 0))
    try:
        port = transport.get_extra_info("sockname")[1]
        info = await coap.get_info("127.0.0.1", port=port, ack_timeout=0.5)
        assert info.device_id == "99"
        await asyncio.sleep(0.05)
        assert protocol.acks == 1
    finally:
        transport.close()
