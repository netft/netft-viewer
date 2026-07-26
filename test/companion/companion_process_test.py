import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import os
from pathlib import Path
import queue
import socket
import struct
import subprocess
import threading
import time
import tempfile
import unittest


SOURCE_DIR = Path(__file__).resolve().parents[2]
DEFAULT_COMPANION = (
    SOURCE_DIR / "build" / "native" / "core" / "companion" / "netft-viewer-companion"
)


def command(command_type: str, request_id: str, payload: dict | None = None) -> str:
    return json.dumps(
        {
            "protocol": {"major": 1, "minor": 0},
            "type": command_type,
            "requestId": request_id,
            "monotonicNs": "0",
            "payload": payload or {},
        },
        separators=(",", ":"),
    )


class CompanionProcess:
    def __init__(self, arguments: list[str] | None = None) -> None:
        executable = Path(os.environ.get("NETFT_VIEWER_COMPANION", DEFAULT_COMPANION))
        self.process = subprocess.Popen(
            [str(executable), *(arguments or [])],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            bufsize=1,
        )
        self._events: queue.Queue[dict | None] = queue.Queue()
        self._logs: list[str] = []
        self._stdout_thread = threading.Thread(target=self._read_stdout)
        self._stderr_thread = threading.Thread(target=self._read_stderr)
        self._stdout_thread.start()
        self._stderr_thread.start()

    def _read_stdout(self) -> None:
        assert self.process.stdout is not None
        for line in self.process.stdout:
            self._events.put(json.loads(line))
        self._events.put(None)

    def _read_stderr(self) -> None:
        assert self.process.stderr is not None
        self._logs.extend(self.process.stderr)

    def send(self, line: str) -> None:
        assert self.process.stdin is not None
        self.process.stdin.write(line + "\n")
        self.process.stdin.flush()

    def read_event(self, timeout: float = 5.0) -> dict:
        try:
            event = self._events.get(timeout=timeout)
        except queue.Empty as error:
            raise TimeoutError("companion event timeout") from error
        if event is None:
            raise AssertionError(
                f"companion exited before an event was received: {''.join(self._logs)}"
            )
        return event

    def read_until(self, predicate) -> tuple[dict, list[dict]]:
        preceding = []
        for _ in range(100):
            event = self.read_event()
            if predicate(event):
                return event, preceding
            preceding.append(event)
        raise AssertionError("expected event was not observed")

    def close(self) -> None:
        if self.process.poll() is None:
            try:
                self.send(command("shutdown", "test-cleanup"))
            except (BrokenPipeError, OSError, ValueError):
                pass
            self.process.wait(timeout=5)
        self._stdout_thread.join(timeout=5)
        self._stderr_thread.join(timeout=5)
        for stream in (self.process.stdin, self.process.stdout, self.process.stderr):
            if stream is not None:
                stream.close()


class FakeSensor:
    def __init__(self) -> None:
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                body = (
                    b"<netft><prodname>Process Fake</prodname>"
                    b"<cfgcpf>1000000</cfgcpf><cfgcpt>1000000</cfgcpt>"
                    b"<scfgfu>N</scfgfu><scfgtu>N-m</scfgtu></netft>"
                )
                self.send_response(200)
                self.send_header("Content-Type", "application/xml")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, _format: str, *args) -> None:
                del args

        self.http = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.http_thread = threading.Thread(target=self.http.serve_forever)
        self.udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.udp.bind(("127.0.0.1", 0))
        self.udp.settimeout(0.005)
        self.commands: list[int] = []
        self.condition = threading.Condition()
        self.stopping = False
        self.streaming = False
        self.peer: tuple[str, int] | None = None
        self.rdt_sequence = 0
        self.ft_sequence = 1000
        self.udp_thread = threading.Thread(target=self._run_udp)

    @property
    def http_port(self) -> int:
        return int(self.http.server_address[1])

    @property
    def rdt_port(self) -> int:
        return int(self.udp.getsockname()[1])

    def __enter__(self):
        self.http_thread.start()
        self.udp_thread.start()
        return self

    def __exit__(self, _type, _value, _traceback) -> None:
        self.stopping = True
        self.udp_thread.join(timeout=5)
        self.udp.close()
        self.http.shutdown()
        self.http.server_close()
        self.http_thread.join(timeout=5)

    def _run_udp(self) -> None:
        next_sample = time.monotonic()
        while not self.stopping:
            try:
                packet, peer = self.udp.recvfrom(64)
                if len(packet) == 8 and packet[:2] == b"\x12\x34":
                    command_code = int.from_bytes(packet[2:4], "big")
                    with self.condition:
                        self.commands.append(command_code)
                        if command_code == 0x0002:
                            self.peer = peer
                            self.streaming = True
                        elif command_code in (0x0000, 0x0042):
                            self.streaming = False
                        self.condition.notify_all()
            except socket.timeout:
                pass

            now = time.monotonic()
            if self.streaming and self.peer is not None and now >= next_sample:
                self.rdt_sequence += 1
                self.ft_sequence += 4
                packet = struct.pack(
                    ">IIIiiiiii",
                    self.rdt_sequence,
                    self.ft_sequence,
                    0,
                    100,
                    -200,
                    300,
                    10,
                    -20,
                    30,
                )
                self.udp.sendto(packet, self.peer)
                next_sample = now + 0.005

    def wait_for_command(self, command_code: int, timeout: float = 5.0) -> bool:
        deadline = time.monotonic() + timeout
        with self.condition:
            while command_code not in self.commands:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return False
                self.condition.wait(remaining)
        return True


class CompanionProcessTest(unittest.TestCase):
    def test_hello_reports_matching_versions(self) -> None:
        companion = CompanionProcess()
        try:
            companion.send(command("hello", "req-1"))
            event = companion.read_event()
            self.assertEqual(event["type"], "hello")
            self.assertEqual(event["requestId"], "req-1")
            self.assertEqual(event["payload"]["protocolMajor"], 1)
            self.assertEqual(event["payload"]["protocolMinor"], 0)
            self.assertEqual(event["payload"]["appVersion"], "0.1.0")
        finally:
            companion.close()

    def test_non_hello_commands_have_correlated_results(self) -> None:
        companion = CompanionProcess()
        try:
            companion.send(command("disconnect", "req-disconnect"))
            result, _ = companion.read_until(
                lambda event: event.get("requestId") == "req-disconnect"
            )
            self.assertEqual(result["type"], "command_result")
            self.assertEqual(result["payload"]["commandType"], "disconnect")
            self.assertTrue(result["payload"]["success"])

            companion.send(
                command("set_paused", "req-pause", payload={"paused": True})
            )
            result, _ = companion.read_until(
                lambda event: event.get("requestId") == "req-pause"
            )
            self.assertEqual(result["payload"]["commandType"], "set_paused")
            self.assertFalse(result["payload"]["success"])
            self.assertEqual(result["payload"]["errorCode"], "invalid_state")
        finally:
            companion.close()

    def test_malformed_input_reports_only_safely_recovered_correlation(self) -> None:
        companion = CompanionProcess()
        try:
            companion.send(
                '{"protocol":{"major":1,"minor":0},"type":"connect",'
                '"requestId":"req-malformed","monotonicNs":"0","payload":{}}'
            )
            correlated = companion.read_event()
            self.assertEqual(correlated["type"], "command_result")
            self.assertEqual(correlated["requestId"], "req-malformed")
            self.assertFalse(correlated["payload"]["success"])
            self.assertEqual(correlated["payload"]["errorCode"], "invalid_command")

            companion.send("{not-json")
            uncorrelated = companion.read_event()
            self.assertEqual(uncorrelated["type"], "error")
            self.assertNotIn("requestId", uncorrelated)
            self.assertEqual(uncorrelated["payload"]["operation"], "protocol")
            self.assertEqual(
                uncorrelated["payload"]["errorCode"], "invalid_command"
            )

            companion.send(
                '{"protocol":{"major":1,"minor":0},"requestId":"req-no-type",'
                '"monotonicNs":"0","payload":{}}'
            )
            missing_type = companion.read_event()
            self.assertEqual(missing_type["type"], "error")
            self.assertEqual(missing_type["requestId"], "req-no-type")

            companion.send(
                '{"protocol":{"major":1,"minor":0},"type":"connect",'
                '"requestId":"first","requestId":"second","monotonicNs":"0",'
                '"payload":{}}'
            )
            duplicate = companion.read_event()
            self.assertEqual(duplicate["type"], "error")
            self.assertNotIn("requestId", duplicate)

            companion.send("x" * (1024 * 1024 + 1))
            oversized = companion.read_event()
            self.assertEqual(oversized["type"], "error")
            self.assertNotIn("requestId", oversized)
        finally:
            companion.close()

    def test_shutdown_result_is_the_last_output_frame(self) -> None:
        companion = CompanionProcess()
        companion.send(command("shutdown", "req-shutdown"))
        result, _ = companion.read_until(
            lambda event: event.get("requestId") == "req-shutdown"
        )
        self.assertEqual(result["type"], "command_result")
        self.assertTrue(result["payload"]["success"])
        self.assertEqual(companion.process.wait(timeout=5), 0)
        self.assertIsNone(companion._events.get(timeout=1))
        companion.close()

    def test_fake_sensor_stream_pause_resume_bias_and_recording(self) -> None:
        with FakeSensor() as sensor, tempfile.TemporaryDirectory() as directory:
            companion = CompanionProcess(
                [
                    f"--rdt-port={sensor.rdt_port}",
                    f"--http-port={sensor.http_port}",
                ]
            )
            target = Path(directory) / "capture.csv"
            try:
                companion.send(
                    command(
                        "connect",
                        "req-connect",
                        payload={"sensorHost": "127.0.0.1"},
                    )
                )
                connected, _ = companion.read_until(
                    lambda event: event.get("requestId") == "req-connect"
                )
                self.assertTrue(connected["payload"]["success"])
                first_sample, _ = companion.read_until(
                    lambda event: event["type"] == "live_wrench"
                )

                companion.send(
                    command(
                        "start_recording",
                        "req-record",
                        payload={"targetPath": str(target), "overwrite": False},
                    )
                )
                started, _ = companion.read_until(
                    lambda event: event.get("requestId") == "req-record"
                )
                self.assertTrue(started["payload"]["success"])
                companion.read_until(
                    lambda event: event["type"] == "live_wrench"
                    and event["payload"]["rdtSequence"]
                    > first_sample["payload"]["rdtSequence"]
                )
                progress, _ = companion.read_until(
                    lambda event: event["type"] == "recording_progress"
                    and int(event["payload"]["acceptedSamples"]) > 0
                )
                self.assertGreater(
                    int(progress["payload"]["acceptedSamples"]), 0
                )
                self.assertLessEqual(
                    int(progress["payload"]["writtenSamples"]),
                    int(progress["payload"]["acceptedSamples"]),
                )

                companion.send(
                    command("set_paused", "req-pause", payload={"paused": True})
                )
                paused, _ = companion.read_until(
                    lambda event: event.get("requestId") == "req-pause"
                )
                self.assertTrue(paused["payload"]["success"])
                deadline = time.monotonic() + 0.1
                while time.monotonic() < deadline:
                    try:
                        event = companion.read_event(timeout=0.02)
                    except TimeoutError:
                        continue
                    self.assertNotIn(event["type"], ("live_wrench", "plot_batch"))

                companion.send(command("bias", "req-paused-bias"))
                rejected_bias, _ = companion.read_until(
                    lambda event: event.get("requestId") == "req-paused-bias"
                )
                self.assertFalse(rejected_bias["payload"]["success"])

                companion.send(
                    command(
                        "set_paused", "req-resume", payload={"paused": False}
                    )
                )
                resumed, _ = companion.read_until(
                    lambda event: event.get("requestId") == "req-resume"
                )
                self.assertTrue(resumed["payload"]["success"])
                companion.read_until(lambda event: event["type"] == "live_wrench")

                companion.send(command("bias", "req-bias"))
                biased, _ = companion.read_until(
                    lambda event: event.get("requestId") == "req-bias"
                )
                self.assertTrue(biased["payload"]["success"])
                self.assertTrue(sensor.wait_for_command(0x0042))
                companion.read_until(lambda event: event["type"] == "live_wrench")

                companion.send(command("stop_recording", "req-stop"))
                stopped, preceding = companion.read_until(
                    lambda event: event.get("requestId") == "req-stop"
                )
                self.assertTrue(stopped["payload"]["success"])
                final_progress = next(
                    (
                        event
                        for event in reversed(preceding)
                        if event["type"] == "recording_progress"
                        and int(event["payload"]["acceptedSamples"])
                        == int(event["payload"]["writtenSamples"])
                        and int(event["payload"]["acceptedSamples"]) > 0
                    ),
                    None,
                )
                if final_progress is None:
                    final_progress, _ = companion.read_until(
                        lambda event: event["type"] == "recording_progress"
                        and int(event["payload"]["acceptedSamples"])
                        == int(event["payload"]["writtenSamples"])
                        and int(event["payload"]["acceptedSamples"]) > 0
                    )
                self.assertTrue(target.is_file())
                self.assertFalse(Path(f"{target}.partial").exists())
                data_rows = len(target.read_text().splitlines()) - 1
                self.assertEqual(
                    int(final_progress["payload"]["acceptedSamples"]), data_rows
                )
                self.assertEqual(
                    int(final_progress["payload"]["writtenSamples"]), data_rows
                )

                companion.send(command("disconnect", "req-disconnect"))
                disconnected, _ = companion.read_until(
                    lambda event: event.get("requestId") == "req-disconnect"
                )
                self.assertTrue(disconnected["payload"]["success"])
            finally:
                companion.close()

    def test_broken_output_pipe_interrupts_an_idle_command_reader(self) -> None:
        with FakeSensor() as sensor:
            executable = Path(
                os.environ.get("NETFT_VIEWER_COMPANION", DEFAULT_COMPANION)
            )
            for iteration in range(5):
                process = subprocess.Popen(
                    [
                        str(executable),
                        f"--rdt-port={sensor.rdt_port}",
                        f"--http-port={sensor.http_port}",
                    ],
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                    encoding="utf-8",
                    bufsize=1,
                )
                assert process.stdin is not None
                assert process.stdout is not None
                try:
                    process.stdin.write(
                        command("hello", f"req-hello-{iteration}") + "\n"
                    )
                    process.stdin.flush()
                    self.assertEqual(
                        json.loads(process.stdout.readline())["type"], "hello"
                    )
                    process.stdin.write(
                        command(
                            "connect",
                            f"req-connect-{iteration}",
                            payload={"sensorHost": "127.0.0.1"},
                        )
                        + "\n"
                    )
                    process.stdin.flush()
                    connected = False
                    streamed = False
                    while not (connected and streamed):
                        event = json.loads(process.stdout.readline())
                        connected = connected or event.get("requestId") == (
                            f"req-connect-{iteration}"
                        )
                        streamed = streamed or event["type"] == "live_wrench"
                    process.stdout.close()
                    self.assertEqual(process.wait(timeout=3), 3)
                finally:
                    if process.poll() is None:
                        process.stdin.close()
                        process.wait(timeout=5)
                    if process.stdin is not None and not process.stdin.closed:
                        process.stdin.close()
                    if process.stderr is not None:
                        process.stderr.close()

    def test_eof_finalizes_an_active_recording(self) -> None:
        with FakeSensor() as sensor, tempfile.TemporaryDirectory() as directory:
            companion = CompanionProcess(
                [
                    f"--rdt-port={sensor.rdt_port}",
                    f"--http-port={sensor.http_port}",
                ]
            )
            target = Path(directory) / "eof.csv"
            companion.send(
                command(
                    "connect",
                    "req-connect",
                    payload={"sensorHost": "127.0.0.1"},
                )
            )
            companion.read_until(
                lambda event: event.get("requestId") == "req-connect"
            )
            companion.read_until(lambda event: event["type"] == "live_wrench")
            companion.send(
                command(
                    "start_recording",
                    "req-record",
                    payload={"targetPath": str(target), "overwrite": False},
                )
            )
            companion.read_until(
                lambda event: event.get("requestId") == "req-record"
            )
            companion.read_until(lambda event: event["type"] == "live_wrench")

            assert companion.process.stdin is not None
            companion.process.stdin.close()
            self.assertEqual(companion.process.wait(timeout=5), 0)
            companion._stdout_thread.join(timeout=5)
            companion._stderr_thread.join(timeout=5)
            self.assertTrue(target.is_file())
            self.assertFalse(Path(f"{target}.partial").exists())
            self.assertGreater(len(target.read_text().splitlines()), 1)
            companion.close()


if __name__ == "__main__":
    unittest.main()
